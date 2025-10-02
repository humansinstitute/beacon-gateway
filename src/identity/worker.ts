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
import { toNpub } from 'applesauce-core/helpers/keys';

// In-memory state to track onboarding conversations
const onboardingState = new Map<string, { step: 'awaiting_nwc' | 'awaiting_ln_address', npub: string }>();

function isUserKnown(gatewayUser: string): boolean {
  try {
    const db = getDB();
    const row = db.query(`SELECT 1 FROM local_npub_map WHERE gateway_user = ?`).get(gatewayUser);
    return !!row;
  } catch (e) {
    console.error('[identity] isUserKnown DB error:', e);
    return false;
  }
}

async function createNewUser(gatewayType: string, gatewayUser: string): Promise<string | null> {
  try {
    const db = getDB();
    // Correctly create a new signer and await the public key
    const signer = new SimpleSigner();
    const pubkey = await signer.getPublicKey();
    // Use the canonical nostr-tools function to encode the npub
    const npub = nip19.npubEncode(pubkey);
    
    const gatewayNpub = getEnv('GATEWAY_NPUB', '');
    
    db.query(
      `INSERT INTO local_npub_map (gateway_type, gateway_npub, gateway_user, user_npub) VALUES (?, ?, ?, ?)`
    ).run(gatewayType, gatewayNpub, gatewayUser, npub);
    
    console.log(`[identity] Created new user mapping for ${gatewayUser} -> ${npub}`);
    return npub;
  } catch (e) {
    console.error('[identity] createNewUser DB error:', e);
    return null;
  }
}

function saveWalletInfo(npub: string, nwcString: string, lnAddress?: string) {
  try {
    const db = getDB();
    const encrypted = encrypt(nwcString);
    db.query(
      `INSERT INTO user_wallets (user_npub, encrypted_nwc_string, ln_address) VALUES (?, ?, ?)`
    ).run(npub, encrypted, lnAddress || null);
    console.log(`[identity] Saved wallet info for ${npub}`);
  } catch (e) {
    console.error('[identity] saveWalletInfo DB error:', e);
  }
}

async function handleOnboarding(msg: BeaconMessage, messageText: string) {
  const gatewayUser = msg.source.from;
  console.log(`[identity] Starting onboarding for ${gatewayUser}`);

  try {
    const state = onboardingState.get(gatewayUser);

    if (!state) { // Start of onboarding
      const npub = await createNewUser(msg.source.gateway.type, gatewayUser);
      if (!npub) {
        enqueueIdentityOut({ to: gatewayUser, body: "Sorry, there was an error creating your account. Please try again later.", gateway: msg.source.gateway });
        return;
      }
      onboardingState.set(gatewayUser, { step: 'awaiting_nwc', npub });
      enqueueIdentityOut({
        to: gatewayUser,
        body: "Alright, lets setup your Bitcoin wallet, please respond with a nostr wallet connect string and I’ll do the rest.",
        gateway: msg.source.gateway,
      });
      console.log(`[identity] Onboarding step 1: Awaiting NWC for ${gatewayUser}`);
      return;
    }

    if (state.step === 'awaiting_nwc') {
      const isValid = await validateNwcString(messageText);
      if (isValid) {
        saveWalletInfo(state.npub, messageText);
        onboardingState.set(gatewayUser, { ...state, step: 'awaiting_ln_address' });
        enqueueIdentityOut({
          to: gatewayUser,
          body: "That all worked, please can you tell me your lightning address for this wallet? Or if its not available just say No",
          gateway: msg.source.gateway,
        });
        console.log(`[identity] Onboarding step 2: Awaiting LN Address for ${gatewayUser}`);
      } else {
        enqueueIdentityOut({
          to: gatewayUser,
          body: "Hey that didn’t work, please ensure its just a valid wallet connect string",
          gateway: msg.source.gateway,
        });
        console.log(`[identity] Invalid NWC string received from ${gatewayUser}`);
      }
      return;
    }

    if (state.step === 'awaiting_ln_address') {
      const lnAddress = messageText.toLowerCase() === 'no' ? null : messageText;
      getDB().query(`UPDATE user_wallets SET ln_address = ? WHERE user_npub = ?`).run(lnAddress, state.npub);
      console.log(`[identity] Updated LN Address for ${state.npub}`);
      
      onboardingState.delete(gatewayUser);
      
      // Notify the brain of the new user
      await notifyBrainOfNewUser({
        gatewayType: msg.source.gateway.type,
        gatewayId: gatewayUser,
        npub: state.npub,
      });
      
      enqueueIdentityOut({
        to: gatewayUser,
        body: "We’ve setup your account and the Beacon Brain will be in touch.",
        gateway: msg.source.gateway,
      });
      console.log(`[identity] Onboarding complete for ${gatewayUser}`);
      return;
    }
  } catch (e) {
    console.error('[identity] CRITICAL ERROR in handleOnboarding:', e);
    enqueueIdentityOut({ to: gatewayUser, body: "Sorry, a critical error occurred during onboarding. Please start over.", gateway: msg.source.gateway });
    onboardingState.delete(gatewayUser);
  }
}

export function startIdentityWorker() {
  consumeIdentityBeacon(async (msg) => {
    try {
      const gatewayUser = msg.source.from;
      console.log(`[identity] worker received message from: ${gatewayUser}, beaconID: ${msg.beaconID}`);

      const messageText = (msg.source.text || '').trim();
      if (!messageText) return;

      // --- Onboarding Flow ---
      if (!isUserKnown(gatewayUser) || onboardingState.has(gatewayUser)) {
        await handleOnboarding(msg, messageText);
        return;
      }

      // --- Payment Confirmation Flow ---
      if (messageText.toLowerCase() === 'yes') {
        console.log(`[identity] Received 'YES' confirmation from ${gatewayUser}.`);
        const pendingPayment = retrieveAndClearConfirmation(gatewayUser);

        if (pendingPayment) {
          console.log(`[identity] Found pending payment for ${gatewayUser}. Processing...`);
          const result = await makePayment(pendingPayment);

          if (result.success) {
            const confirmationText = `Payment confirmed! Your receipt is: ${result.receipt}`;
            enqueueIdentityOut({ to: gatewayUser, body: confirmationText, gateway: msg.source.gateway });
            await sendPaymentConfirmation('paid', `Successful payment. Receipt: ${result.receipt}`, pendingPayment);
          } else {
            enqueueIdentityOut({ to: gatewayUser, body: `Payment failed: ${result.error}`, gateway: msg.source.gateway });
            await sendPaymentConfirmation('rejected', result.error || 'Payment failed', pendingPayment);
          }
        } else {
          console.log(`[identity] No pending payment found for ${gatewayUser}. Ignoring 'YES'.`);
        }
        return;
      }
      
      // If user is known but there's no 'YES', we can add more commands here later.
      console.log(`[identity] No handler for known user message: "${messageText}"`);

    } catch (e) {
      console.error('[identity] CRITICAL ERROR in consumeIdentityBeacon:', e);
    }
  });
  console.log('[identity] worker started');
}
