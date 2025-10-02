import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from '@contextvm/sdk';
import { z } from 'zod';
import { getEnv } from '../../types';
import { getOutboundContext, forget } from '../beacon_store';

// Default relays
const RELAYS = ['wss://cvm.otherstuff.ai']; // 'wss://relay.contextvm.org', -> currently down

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

// Helpers
function normalizeWhatsAppJid(input: string): string | null {
  let s = input.trim();
  if (s.includes('@')) {
    const [user, domain] = s.split('@');
    if (!user || !domain) return null;
    s = user.replace(/\D+/g, '');
  } else {
    s = s.replace(/\D+/g, '');
  }
  if (!s || s.length < 5) return null;
  return `${s}@c.us`;
}

  const signer = new PrivateKeySigner(privateKey);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();
  console.log('[brain-cvm] starting', { serverPubkey: serverPubkey.slice(0, 8) + '…', relays: RELAYS });

  const mcpServer = new McpServer({ name: 'beacon-brain-cvm-server', version: '1.0.0' });

  // Register onboardUser tool (maps local gateway identifier to user npub)
  mcpServer.registerTool(
    'onboardUser',
    {
      title: 'Onboard User',
      description: 'Create or extend a mapping from a local gateway identifier (e.g., WhatsApp JID) to a user npub',
      inputSchema: {
        gatewayType: z.enum(['whatsapp']),
        gatewayID: z.string().min(3),
        Npub: z.string().min(10),
        beacon_id_npub: z.string().min(10),
      },
    },
    async (args) => {
      try {
        const gatewayType = String(args.gatewayType || '').toLowerCase();
        const gatewayIdRaw = String(args.gatewayID || '').trim();
        const userNpub = String(args.Npub || '').trim();
        const beaconIdNpub = String(args.beacon_id_npub || '').trim();
        if (!gatewayIdRaw) return { status: 'failure', description: 'invalid input: gatewayID required' };
        if (!userNpub) return { status: 'failure', description: 'invalid input: Npub required' };
        if (!beaconIdNpub) return { status: 'failure', description: 'invalid input: beacon_id_npub required' };

        // Use the gateway npub configured on this server to route outbound via this gateway.
        const gatewayNpub = getEnv('GATEWAY_NPUB', '').trim();
        if (!gatewayNpub) {
          return { status: 'failure', description: 'missing server GATEWAY_NPUB' };
        }

        let gatewayUser = gatewayIdRaw;
        if (gatewayType === 'whatsapp') {
          const jid = normalizeWhatsAppJid(gatewayUser);
          if (!jid) return { status: 'failure', description: 'invalid input: malformed WhatsApp ID' };
          gatewayUser = jid;
        }

        const { getDB } = await import('../../db');
        const db = getDB();

        const existingExact = db
          .query(`SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`)
          .get(gatewayType, gatewayNpub, gatewayUser) as any;

        if (existingExact && existingExact.user_npub === userNpub) {
          return { status: 'failure', description: 'preexisting user' };
        }
        if (existingExact && existingExact.user_npub !== userNpub) {
          return { status: 'failure', description: 'conflict: gatewayID already mapped to a different npub' };
        }

        const existingForUser = db
          .query(`SELECT id FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND user_npub = ? LIMIT 1`)
          .get(gatewayType, gatewayNpub, userNpub) as any;

        const insert = db.query(`
          INSERT INTO local_npub_map (
            gateway_type, gateway_npub, gateway_user, user_npub, beacon_brain_npub, beacon_id_npub
          ) VALUES (?, ?, ?, ?, NULL, ?)
        `);
        let didInsert = false;
        try {
          insert.run(gatewayType, gatewayNpub, gatewayUser, userNpub, beaconIdNpub);
          didInsert = true;
        } catch (e) {
          const nowExact = db
            .query(`SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`)
            .get(gatewayType, gatewayNpub, gatewayUser) as any;
          if (nowExact && nowExact.user_npub === userNpub) {
            return { status: 'failure', description: 'preexisting user' };
          }
          return { status: 'failure', description: 'db error: unable to insert mapping' };
        }

        // Send welcome message to the user for newly established mapping
        if (didInsert) {
          const welcome = 'Welcome to Beacon. How can we help? Free Information and Freedom Money.';
          const { createOutboundMessage } = await import('../../db');
          const { enqueueOut } = await import('../../queues');
          const { checkConversation } = await import('../checkConversation');
          const conv = await checkConversation({ userNpub, messageText: welcome });
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: conv.conversationId,
            replyToMessageId: null,
            role: 'beacon',
            userNpub,
            content: { text: welcome, to: gatewayUser, quotedMessageId: null },
            metadata: { gateway: { type: gatewayType, npub: gatewayNpub }, source: 'cvm_onboard' },
            channel: gatewayType,
          });
          enqueueOut({
            to: gatewayUser,
            body: welcome,
            quotedMessageId: null,
            deliveryId,
            messageId,
            gateway: { type: gatewayType as any, npub: gatewayNpub },
          });
        }

        if (existingForUser) {
          return { status: 'success', description: 'added gateway to existing npub' };
        }
        return { status: 'success', description: 'created new mapping' };
      } catch (err) {
        console.error('[brain-cvm] onboardUser error', err);
        return { status: 'failure', description: 'unexpected error' };
      }
    }
  );

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
