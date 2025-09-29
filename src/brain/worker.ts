import { consumeBeacon, enqueueOut } from '../queues';
import type { BeaconMessage, GatewayOutData } from '../types';
import { toGatewayOut } from '../types';
import { quickResponseWithAgent } from './quick_response';
import conversationAgent from './agents/conversationAgent';

export function startBrainWorker() {
  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      // Determine input text for quick response
      let text = (msg.source.text || '').trim();
      if (!text) {
        try {
          const parsed = JSON.parse(msg.source.messageData);
          const candidate = (parsed?.body || parsed?.text || '').toString();
          text = (candidate || '').trim();
        } catch {}
      }
      if (!text) {
        // No reasonable text found; skip responding
        console.log('[brain] no text to respond with for beaconID:', msg.beaconID);
        return;
      }

      // Call the quick response using the conversation agent definition
      const answer = await quickResponseWithAgent(conversationAgent, text, undefined);

      // Populate response envelope
      msg.response = {
        to: msg.source.from || '',
        text: answer,
        quotedMessageId: msg.source.messageId,
        gateway: { ...msg.source.gateway },
      };

      // For now, convert to legacy outbound for adapters
      const out: GatewayOutData = toGatewayOut(msg);
      console.log('[brain] enqueue outbound message:', out);
      enqueueOut(out);
    } catch (err) {
      console.error('[brain] error handling beacon message:', { beaconID: msg.beaconID, err });
    }
  });
  console.log('[brain] worker started (quick_response)');
}
