// src/gateway/nostr/index.ts
// This adapter handles communication via Nostr NIP-04 encrypted direct messages.

import { RelayPool } from 'applesauce-relay';
import { SimpleSigner } from 'applesauce-signers';
import { nip19 } from 'nostr-tools';
import { getEnv, toBeaconMessage, BeaconMessage, GatewayOutData } from '../../types';
import { consumeOut as brainConsumeOut, enqueueBeacon as brainEnqueueBeacon } from '../../queues';

export async function startNostrAdapter(options?: {
  enqueueBeacon?: (msg: BeaconMessage) => void;
  consumeOut?: (handler: (out: GatewayOutData) => Promise<void> | void) => void;
}) {
  const enqueueBeacon = options?.enqueueBeacon || brainEnqueueBeacon;
  const consumeOut = options?.consumeOut || brainConsumeOut;

  console.log('[nostr] adapter starting...');

  const privateKey = getEnv('GATEWAY_PRIVATE_KEY', '');
  if (!privateKey) {
    console.error('[nostr] FATAL: GATEWAY_PRIVATE_KEY is not set. Nostr adapter cannot start.');
    return;
  }

  const relays = (getEnv('NOSTR_RELAYS', 'wss://relay.damus.io,wss://relay.primal.net')).split(',');
  if (relays.length === 0) {
    console.error('[nostr] FATAL: NOSTR_RELAYS are not set. Nostr adapter cannot start.');
    return;
  }

  try {
    let privateKeyHex: string;
    if (privateKey.startsWith('nsec')) {
      const { type, data } = nip19.decode(privateKey);
      if (type !== 'nsec') throw new Error('Invalid nsec private key');
      privateKeyHex = Buffer.from(data).toString('hex');
    } else {
      privateKeyHex = privateKey;
    }

    const signer = new SimpleSigner(privateKeyHex);
    const ourPubkeyHex = await signer.getPublicKey();
    const ourNpub = nip19.npubEncode(ourPubkeyHex);
    console.log(`[nostr] Gateway listening for DMs on npub: ${ourNpub}`);

    const pool = new RelayPool();

    const startupTime = Math.floor(Date.now() / 1000); // Record startup time in seconds

    // --- Inbound Flow (Nostr DM -> Beacon) ---
    // The `subscription` method takes the relays as the first argument.
    const sub = pool.subscription(relays, [{ kinds: [4], '#p': [ourPubkeyHex] }]);
    
    sub.subscribe(async (event) => {
      try {
        // Ignore events created before the service started
        if (event.created_at < startupTime) {
          console.log(`[nostr] Ignoring old DM event ${event.id}`);
          return;
        }

        console.log(`[nostr] Received potential DM, eventId: ${event.id}`);
        console.log('[nostr] Raw event:', JSON.stringify(event, null, 2));
        console.log(`[nostr] Type of event.content: ${typeof event.content}`);

        if (typeof event.content !== 'string') {
          throw new Error('Event content is not a string, cannot decrypt.');
        }
        
        const senderPubkeyHex = event.pubkey;
        const senderNpub = nip19.npubEncode(senderPubkeyHex);

        const decryptedText = await signer.nip04.decrypt(senderPubkeyHex, event.content);

        const beaconMsg = toBeaconMessage(
          { source: 'nostr', text: decryptedText, from: senderNpub },
          { type: 'nostr', npub: ourNpub },
          { from: senderNpub, text: decryptedText, messageId: event.id }
        );

        console.log(`[nostr] Enqueuing inbound DM from ${senderNpub}`);
        enqueueBeacon(beaconMsg);

      } catch (e) {
        console.error(`[nostr] Error processing inbound event ${event.id}:`, e);
      }
    });

    // --- Outbound Flow (Beacon -> Nostr DM) ---
    consumeOut(async (msg: GatewayOutData) => {
      if (msg.gateway.type !== 'nostr') {
        return;
      }

      try {
        console.log(`[nostr] Processing outbound message to ${msg.to}`);
        const recipientNpub = msg.to;
        const { type, data: recipientPubkeyHex } = nip19.decode(recipientNpub);

        if (type !== 'npub' || typeof recipientPubkeyHex !== 'string') {
          throw new Error(`Invalid recipient npub: ${recipientNpub}`);
        }

        const encryptedContent = await signer.nip04.encrypt(recipientPubkeyHex, msg.body);

        const event = {
          kind: 4,
          content: encryptedContent,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', recipientPubkeyHex]],
        };

        const signedEvent = await signer.signEvent(event);
        // The `publish` method also takes the relays as the first argument.
        pool.publish(relays, signedEvent);
        console.log(`[nostr] Sent outbound DM to ${recipientNpub}`);

      } catch (e) {
        console.error(`[nostr] Error processing outbound message to ${msg.to}:`, e);
      }
    });

    console.log('[nostr] adapter started and subscribed to DMs.');

  } catch (e) {
    console.error('[nostr] adapter failed to start:', e);
  }
}
