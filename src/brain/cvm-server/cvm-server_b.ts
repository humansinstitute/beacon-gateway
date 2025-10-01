import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from '@contextvm/sdk';
import { z } from 'zod';
import { getEnv } from '../../types';
import { getOutboundContext, forget } from '../beacon_store';

// Default relays
const RELAYS = ['wss://relay.contextvm.org', 'wss://cvm.otherstuff.ai'];

// Zod schema for confirmPayment input
const ConfirmPaymentSchema = {
  status: z.enum(['paid', 'rejected']),
  reason: z.string(),
  type: z.enum(['payLnInvoice', 'payLnAddress']),
  data: z.object({
    npub: z.string().optional().default(''),
    refId: z.string(),
    lnInvoice: z.string().optional(),
    lnAddress: z.string().optional(),
    responsePubkey: z.string(),
    responseTool: z.string(),
  }),
};

export async function startBrainCvmServer() {
  const privateKey = getEnv('BRAIN_CVM_PRIVATE_KEY', '').trim();
  if (!privateKey || privateKey.startsWith('YOUR_')) {
    console.warn('[brain-cvm] BRAIN_CVM_PRIVATE_KEY not set; Brain CVM server will not start');
    return;
  }

  const signer = new PrivateKeySigner(privateKey);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();
  console.log('[brain-cvm] starting', { serverPubkey: serverPubkey.slice(0, 8) + '…', relays: RELAYS });

  const mcpServer = new McpServer({ name: 'beacon-brain-cvm-server', version: '1.0.0' });

  // Register confirmPayment tool
  mcpServer.registerTool(
    'confirmPayment',
    {
      title: 'Confirm Payment',
      description: 'Receives final payment confirmation and routes a reply',
      inputSchema: ConfirmPaymentSchema,
    },
    async (args) => {
      try {
        const { status, reason, type, data } = args as z.infer<z.ZodObject<any>> as any;
        console.log('[brain-cvm] confirmPayment received', {
          status,
          type,
          refId: data?.refId,
          reason: (reason || '').slice(0, 200),
        });

        const beaconID = data?.refId || '';
        if (!beaconID) return { status: 'error', details: 'refId missing' };

        const ctx = getOutboundContext(beaconID);
        if (!ctx) {
          console.warn('[brain-cvm] no routing context for beaconID', { beaconID });
          return { status: 'error', details: 'Unknown beaconID' };
        }

        const { enqueueOut } = await import('../../queues');
        const { createOutboundMessage } = await import('../../db');

        const text = status === 'paid' ? 'Payment Confirmed' : `Payment ${status}: ${reason || ''}`.trim();

        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: ctx.conversationId || '',
          replyToMessageId: ctx.inboundMessageId || null,
          role: 'beacon',
          userNpub: ctx.userNpub || null,
          content: {
            text,
            to: ctx.to,
            quotedMessageId: ctx.quotedMessageId,
            beaconId: beaconID,
          },
          metadata: { gateway: ctx.gateway, source: 'cvm_confirm' },
          channel: ctx.gateway.type,
        });

        enqueueOut({
          to: ctx.to,
          body: text,
          quotedMessageId: ctx.quotedMessageId,
          deliveryId,
          messageId,
          gateway: ctx.gateway,
        });
        console.log('[brain-cvm] reply queued', { beaconID, to: ctx.to, status });
        forget(beaconID);
        return { status: 'ok' };
      } catch (err) {
        console.error('[brain-cvm] confirmPayment handler error', { err });
        return { status: 'error', details: String((err as Error)?.message || err) };
      }
    }
  );

  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: { name: 'Beacon Brain CVM Server' },
  });

  await mcpServer.connect(serverTransport);
  console.log('[brain-cvm] server listening on Nostr');
}

