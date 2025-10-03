// src/identity/worker.ts
// This contains the core logic for the Identity service,
// processing messages from its dedicated queue.

import { nip19 } from 'nostr-tools';
import { consumeIdentityBeacon, enqueueIdentityOut } from './queues';
import { retrieveAndClearConfirmation } from './pending_store';
import { makePayment, validateNwcString } from './wallet_manager';
import { getEnv, BeaconMessage } from '../types';
import { sendPaymentConfirmation, notifyBrainOfNewUser } from './cvm';
import { getDB } from '../db';
import { encrypt } from './encryption';
import { SimpleSigner } from 'applesauce-signers';

const onboardingState = new Map<string, { step: 'awaiting_nwc' | 'awaiting_ln_address', npub: string }>();

// --- DB Helpers ---

function findUserByGatewayId(gatewayType: string, gatewayUser: string): string | null {
  const db = getDB();
  const row = db.query(`SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_user = ?`).get(gatewayType, gatewayUser) as any;
  return row?.user_npub || null;
}

function addNewGatewayMapping(npub: string, gatewayType: string, gatewayUser: string) {
  const db = getDB();
  const gatewayNpub = getEnv('GATEWAY_NPUB', '');
  db.query(
    `INSERT INTO local_npub_map (gateway_type, gateway_npub, gateway_user, user_npub) VALUES (?, ?, ?, ?)`
  ).run(gatewayType, gatewayNpub, gatewayUser, npub);
  console.log(`[identity] Added new gateway mapping for ${gatewayUser} -> ${npub}`);
}

function saveNewManagedIdentity(npub: string, nsec: string) {
  try {
    const db = getDB();
    const encryptedNsec = encrypt(nsec);
    db.query(`INSERT INTO user_wallets (user_npub, encrypted_nsec) VALUES (?, ?)`).run(npub, encryptedNsec);
    console.log(`[identity] Saved new managed identity for ${npub}`);
  } catch (e) {
    console.error('[identity] saveNewManagedIdentity DB error:', e);
  }
}

function saveNwcString(npub: string, nwcString: string) {
  try {
    const db = getDB();
    const encryptedNwc = encrypt(nwcString);
    db.query(`UPDATE user_wallets SET encrypted_nwc_string = ? WHERE user_npub = ?`).run(encryptedNwc, npub);
    console.log(`[identity] Saved NWC string for ${npub}`);
  } catch (e) {
    console.error('[identity] saveNwcString DB error:', e);
  }
}

// --- Onboarding Logic ---

async function createNewUser(gatewayType: string, gatewayUser: string): Promise<string | null> {
  try {
    // ALWAYS generate a new internal identity for every new user.
    const signer = new SimpleSigner();
    const nsec = signer.key; // The raw private key is in the 'key' property
    const pubkey = await signer.getPublicKey();
    const npub = nip19.npubEncode(pubkey);
    const nsec_encoded = nip19.nsecEncode(nsec);

    // Save the encrypted nsec for this new user.
    saveNewManagedIdentity(npub, nsec_encoded);

    // Map the user's external ID (phone number, nostr pubkey, etc.) to their new internal npub.
    addNewGatewayMapping(npub, gatewayType, gatewayUser);
    
    console.log(`[identity] Created new managed identity ${npub} for gateway ${gatewayType}:${gatewayUser}`);
    return npub;
  } catch (e) {
    console.error('[identity] createNewUser error:', e);
    return null;
  }
}

async function handleOnboarding(msg: BeaconMessage, messageText: string) {
  const gatewayUser = msg.source.from;
  const state = onboardingState.get(gatewayUser);

  if (!state) { // First message from a new user
    const npub = await createNewUser(msg.source.gateway.type, gatewayUser);
    if (!npub) {
      enqueueIdentityOut({ to: gatewayUser, body: "Sorry, there was an error creating your account.", gateway: msg.source.gateway });
      return;
    }
    onboardingState.set(gatewayUser, { step: 'awaiting_nwc', npub });
    enqueueIdentityOut({ to: gatewayUser, body: "Alright, lets setup your Bitcoin wallet, please respond with a nostr wallet connect string and I’ll do the rest.", gateway: msg.source.gateway });
    return;
  }

  if (state.step === 'awaiting_nwc') {
    const isValid = await validateNwcString(messageText);
    if (isValid) {
      saveNwcString(state.npub, messageText);
      onboardingState.set(gatewayUser, { ...state, step: 'awaiting_ln_address' });
      enqueueIdentityOut({ to: gatewayUser, body: "That all worked. What is your lightning address? (or say No)", gateway: msg.source.gateway });
    } else {
      enqueueIdentityOut({ to: gatewayUser, body: "Hey that didn’t work, please try again.", gateway: msg.source.gateway });
    }
    return;
  }

  if (state.step === 'awaiting_ln_address') {
    const lnAddress = messageText.toLowerCase() === 'no' ? null : messageText;
    getDB().query(`UPDATE user_wallets SET ln_address = ? WHERE user_npub = ?`).run(lnAddress, state.npub);
    
    onboardingState.delete(gatewayUser);
    await notifyBrainOfNewUser({ gatewayType: msg.source.gateway.type, gatewayId: gatewayUser, npub: state.npub });
    enqueueIdentityOut({ to: gatewayUser, body: "We’ve setup your account. The Beacon Brain will be in touch.", gateway: msg.source.gateway });
  }
}

export function startIdentityWorker() {
  consumeIdentityBeacon(async (msg) => {
    try {
      const gatewayUser = msg.source.from;
      const messageText = (msg.source.text || '').trim();
      if (!messageText) return;

      let userNpub = findUserByGatewayId(msg.source.gateway.type, gatewayUser);

      if (!userNpub || onboardingState.has(gatewayUser)) {
        await handleOnboarding(msg, messageText);
        return;
      }

      if (messageText.toLowerCase() === 'yes') {
        const pendingPayment = retrieveAndClearConfirmation(gatewayUser);
        if (pendingPayment) {
          const result = await makePayment(pendingPayment);
          if (result.success) {
            enqueueIdentityOut({ to: gatewayUser, body: `Payment confirmed! Receipt: ${result.receipt}`, gateway: msg.source.gateway });
            await sendPaymentConfirmation('paid', `Successful payment. Receipt: ${result.receipt}`, pendingPayment);
          } else {
            enqueueIdentityOut({ to: gatewayUser, body: `Payment failed: ${result.error}`, gateway: msg.source.gateway });
            await sendPaymentConfirmation('rejected', result.error || 'Payment failed', pendingPayment);
          }
        }
        return;
      }
      
      console.log(`[identity] No handler for known user message: "${messageText}"`);

    } catch (e) {
      console.error('[identity] CRITICAL ERROR in consumeIdentityBeacon:', e);
    }
  });
  console.log('[identity] worker started');
}
