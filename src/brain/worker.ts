import { consumeIn, enqueueOut } from '../queues';
import type { GatewayInData, GatewayOutData } from '../types';

export function startBrainWorker() {
  consumeIn(async (msg: GatewayInData) => {
    const out: GatewayOutData = {
      to: msg.from,
      body: 'Pong!',
      quotedMessageId: msg.originalMessageId,
      gateway: { ...msg.gateway },
    };
    // Log the exact outbound message structure before enqueueing/sending
    console.log('[brain] enqueue outbound message:', out);
    enqueueOut(out);
  });
  console.log('[brain] worker started (Pong! responder)');
}
