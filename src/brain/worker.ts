import { consumeBeacon, enqueueOut } from '../queues';
import type { BeaconMessage, GatewayOutData } from '../types';
import { toGatewayOut } from '../types';
import { quickResponseWithAgent } from './callAI.util';
import conversationAgent from './agents/conversationAgent.ts';
import { routeIntent } from './intent_router';
import { rememberInbound } from './beacon_store';
import { triggerWingmanForBeacon } from './wingman.client';
import { recordInboundMessage, logAction, setMessageResponse } from '../db';

export function startBrainWorker() {
  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      // Remember routing context for potential webhook responses
      rememberInbound(msg);
      // Persist inbound message
      recordInboundMessage(msg);

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
        const info = await triggerWingmanForBeacon(msg);
        logAction(msg.beaconID, 'wingman_trigger', info, 'ok');
        return; // wingman webhook will deliver the response
      }

      logAction(msg.beaconID, 'ai_request', { agent: 'conversation', preview: text.slice(0, 200) });
      const answer = await quickResponseWithAgent(conversationAgent, text, undefined);
      logAction(msg.beaconID, 'ai_response', { answerPreview: answer.slice(0, 200) }, 'ok');

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
      setMessageResponse(msg.beaconID, answer, 'ai');
    } catch (err) {
      console.error('[brain] error handling beacon message:', { beaconID: msg.beaconID, err });
      logAction(msg.beaconID, 'error', { message: String((err as Error)?.message || err) }, 'failed');
      setMessageResponse(msg.beaconID, null, null, String((err as Error)?.message || err));
    }
  });
  console.log('[brain] worker started (intent_router + wingman)');
}
