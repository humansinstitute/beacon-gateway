import { consumeBeacon, enqueueOut } from '../queues';
import type { BeaconMessage, GatewayOutData } from '../types';
import { toGatewayOut } from '../types';
import { quickResponseWithAgent } from './callAI.util';
import conversationAgent from './agents/conversationAgent.ts';
import { routeIntent } from './intent_router';
import { rememberInbound } from './beacon_store';
import { triggerWingmanForBeacon } from './wingman.client';
import { recordInboundMessage, logAction, createOutboundMessage } from '../db';
import { getEnv } from '../types';
import { payLnAddress as cvmPayLnAddress } from './cvm_client/cvm_client';
import { checkConversation } from './checkConversation';
import { maybeConsolidate } from './conversation/consolidate.util';

export function startBrainWorker() {
  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      // Determine input text early for conversation analysis
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

      // Resolve conversation (use analyst when not a reply)
      const conv = await checkConversation({ replyToMessageId: undefined, userNpub: msg.meta?.userNpub || null, messageText: text });
      msg.meta = msg.meta || {};
      msg.meta.conversationID = conv.conversationId;

      // Persist inbound message and remember routing context
      const inboundMessageId = recordInboundMessage(msg);

      // Consolidate conversation state periodically and prepare history string
      let historyString: string | undefined;
      try {
        const { summary, deltaSinceSummary } = await maybeConsolidate(msg.meta?.conversationID || '');
        if (summary) {
          if (deltaSinceSummary <= 1) {
            historyString = `The previous message history is: ${summary}`;
          } else {
            // stale-ish summary; still useful
            historyString = `Conversation summary: ${summary}`;
          }
        }
      } catch {}
      rememberInbound(msg, inboundMessageId);

      // Route by intent (simple rules); default falls back to AI
      const route = routeIntent(text);
      if (route.type === 'wingman') {
        const info = await triggerWingmanForBeacon(msg, { historySummary: historyString });
        logAction(msg.beaconID, 'wingman_trigger', info, 'ok');
        return; // wingman webhook will deliver the response
      }

      // If router returned a preset default text (e.g., for "pay" heuristic), send it directly.
      if ((route as any).type === 'default_with_text') {
        // Trigger CVM pay flow with hardcoded args when user intent starts with "pay"
        try {
          const lnAddress = 'noah@sats.com';
          const amount = 256;
          const responsePubkey = getEnv('BEACON_BRAIN_HEX_PUB', '').trim() ||
            'caabbef036b063f6b29e8bc79f723aae8fb8eddc56fe198f150bae6a01741ee3';
          await cvmPayLnAddress({
            npub: 'npub1hs7h7pfsdeqxmhkk9vmutuqs0vztv503c4ve6wlq3nn2a58w6cfss9sus3',
            refId: msg.beaconID,
            lnAddress,
            amount,
            responsePubkey,
            responseTool: 'confirmPayment',
          });
          logAction(msg.beaconID, 'cvm_payLnAddress', { lnAddress, amount, responsePubkey: responsePubkey.slice(0,8) + '…' }, 'sent');
        } catch (err) {
          console.error('[brain] cvm payLnAddress error', { beaconID: msg.beaconID, err });
          logAction(msg.beaconID, 'cvm_payLnAddress', { error: String((err as Error)?.message || err) }, 'failed');
        }

        const answer = `I sent a request to your Beacon ID to pay noah@sats.com 256 sats. Just waiting on confirmation.`;
        logAction(msg.beaconID, 'preset_response', { answerPreview: answer.slice(0, 200) }, 'ok');

        msg.response = {
          to: msg.source.from || '',
          text: answer,
          quotedMessageId: msg.source.messageId,
          gateway: { ...msg.source.gateway },
        };

        // Create outbound message + delivery (queued)
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '',
          replyToMessageId: inboundMessageId,
          role: 'beacon',
          userNpub: msg.meta?.userNpub || null,
          content: {
            text: answer,
            to: msg.source.from || '',
            quotedMessageId: msg.source.messageId,
            beaconId: msg.beaconID,
          },
          metadata: { gateway: msg.source.gateway },
          channel: msg.source.gateway.type,
        });

        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
        console.log('[brain] enqueue outbound message:', { ...out });
        enqueueOut(out);
        return;
      }

      logAction(msg.beaconID, 'ai_request', { agent: 'conversation', preview: text.slice(0, 200) });
      const answer = await quickResponseWithAgent(conversationAgent, text, historyString);
      logAction(msg.beaconID, 'ai_response', { answerPreview: answer.slice(0, 200) }, 'ok');

      // Populate response envelope
      msg.response = {
        to: msg.source.from || '',
        text: answer,
        quotedMessageId: msg.source.messageId,
        gateway: { ...msg.source.gateway },
      };

      // For now, convert to legacy outbound for adapters
      // Create outbound message + delivery (queued)
      const { messageId, deliveryId } = createOutboundMessage({
        conversationId: msg.meta?.conversationID || '',
        replyToMessageId: inboundMessageId,
        role: 'beacon',
        userNpub: msg.meta?.userNpub || null,
        content: {
          text: answer,
          to: msg.source.from || '',
          quotedMessageId: msg.source.messageId,
          beaconId: msg.beaconID,
        },
        metadata: { gateway: msg.source.gateway },
        channel: msg.source.gateway.type,
      });

      const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
      console.log('[brain] enqueue outbound message:', { ...out });
      enqueueOut(out);
    } catch (err) {
      console.error('[brain] error handling beacon message:', { beaconID: msg.beaconID, err });
      logAction(msg.beaconID, 'error', { message: String((err as Error)?.message || err) }, 'failed');
    }
  });
  console.log('[brain] worker started (intent_router + wingman)');
}
