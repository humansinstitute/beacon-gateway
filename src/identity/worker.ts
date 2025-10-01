// src/identity/worker.ts
// This contains the core logic for the Identity service,
// processing messages from its dedicated queue.

import { consumeIdentityBeacon, enqueueIdentityOut } from './queues';
import { retrieveAndClearConfirmation } from './pending_store';
import { makePayment } from './wallet_manager';
import { getEnv } from '../types';
import { sendPaymentConfirmation } from './cvm';

export function startIdentityWorker() {
  consumeIdentityBeacon(async (msg) => {
    console.log(`[identity] worker received message from: ${msg.source.from}, beaconID: ${msg.beaconID}`);

    // We only care about simple text messages for confirmation
    const messageText = (msg.source.text || '').trim();
    if (!messageText) {
      return;
    }

    // Check if the message is a 'YES' confirmation
    if (messageText.toLowerCase() === 'yes') {
      const userJid = msg.source.from;
      if (!userJid) return;

      console.log(`[identity] Received 'YES' confirmation from ${userJid}.`);

      // Retrieve the pending payment details. This also clears it from the store.
      const pendingPayment = retrieveAndClearConfirmation(userJid);

      if (pendingPayment) {
        console.log(`[identity] Found pending payment for ${userJid}. Processing...`);
        
        // Call the (mock) wallet to make the payment
        const result = await makePayment(pendingPayment);

        if (result.success) {
          console.log(`[identity] Mock payment successful. Receipt: ${result.receipt}`);
          
          // Send a confirmation message back to the user
          const confirmationText = `Payment confirmed! Your receipt is: ${result.receipt}`;
          enqueueIdentityOut({
            to: userJid,
            body: confirmationText,
            gateway: { type: 'whatsapp', npub: getEnv('GATEWAY_NPUB', '').trim() }
          });

          // Step 3.4: Call the CVM client to send confirmation to the Brain.
          sendPaymentConfirmation('paid', `Successful payment. Receipt: ${result.receipt}`, pendingPayment);

        } else {
          console.error(`[identity] Mock payment failed: ${result.error}`);
          // Handle payment failure (e.g., notify user and Brain).
          enqueueIdentityOut({
            to: userJid,
            body: `Payment failed: ${result.error}`,
            gateway: { type: 'whatsapp', npub: getEnv('GATEWAY_NPUB', '').trim() }
          });
          sendPaymentConfirmation('rejected', result.error || 'Payment failed for an unknown reason.', pendingPayment);
        }

      } else {
        console.log(`[identity] No pending payment found for ${userJid}. Ignoring 'YES'.`);
        // TODO: Optionally, send a message to the user saying "I wasn't waiting for a confirmation from you."
      }
    }
  });
  console.log('[identity] worker started');
}