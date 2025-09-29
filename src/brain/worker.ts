import { consumeBeacon, enqueueOut } from '../queues';
import type { BeaconMessage, GatewayOutData } from '../types';
import { toGatewayOut } from '../types';
import { quickResponseWithAgent } from './callAI.util';
import conversationAgent from './agents/conversationAgent.ts';
import { routeIntent } from './intent_router';
import { rememberInbound } from './beacon_store';
import { triggerWingmanForBeacon } from './wingman.client';

export function startBrainWorker() {
  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      // Remember routing context for potential webhook responses
      rememberInbound(msg);

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

      // Route by intent (simple rules); default falls back to AI
      const route = routeIntent(text);
      if (route.type === 'wingman') {
        await triggerWingmanForBeacon(msg);
        return; // wingman webhook will deliver the response
      }

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
  console.log('[brain] worker started (intent_router + wingman)');
}
