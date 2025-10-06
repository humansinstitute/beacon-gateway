import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from '@contextvm/sdk';
import { z } from 'zod';
import { getEnv, toBeaconMessage, type GatewayType } from '../../types';
import { getOutboundContext, forget } from '../beacon_store';
import { enqueueBeacon } from '../../queues';
import { recordInboundMessage, createOutboundMessage } from '../../db';

// Default relays
function parseRelays(s: string | undefined | null): string[] {
  const raw = (s || '').trim();
  if (!raw) return ['wss://cvm.otherstuff.ai', 'wss://relay.contextvm.org'];
  return raw.split(',').map((r) => r.trim()).filter(Boolean);
}
const RELAYS = parseRelays(getEnv('CVM_RELAYS', ''));

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

  // -------------------- receiveMessage tool --------------------
  const ReceiveMessageSchema = {
    refId: z.string().min(3),
    returnGatewayID: z.string().min(3), // gateway npub
    networkID: z.string().min(2),
    botid: z.string().optional().default(''),
    botType: z.string().optional().default(''),
    groupID: z.string().optional().default(''),
    userId: z.string().min(1),
    messageID: z.string().optional().default(''),
    message: z.string().optional().default(''),
  } as const;

  function mapNetworkToGatewayType(networkID: string): GatewayType | null {
    const s = (networkID || '').toLowerCase();
    if (s === 'whatsapp') return 'whatsapp';
    if (s === 'signal') return 'signal';
    if (s === 'nostr') return 'nostr';
    if (s === 'web') return 'web';
    if (s === 'mesh') return 'mesh';
    if (s === 'qaul') return 'qaul';
    return null;
  }

  // Do not normalize userId; gateways handle this.
  function passthroughUserId(_network: GatewayType, userId: string): string | null {
    const v = String(userId || '').trim();
    return v || null;
  }

  mcpServer.registerTool(
    'receiveMessage',
    {
      title: 'Receive Message',
      description: 'Enqueue a message into the Beacon processing pipeline while preserving full routing context',
      inputSchema: ReceiveMessageSchema,
    },
    async (args) => {
      try {
        console.log('[brain-cvm] receiveMessage <-', {
          refId: String((args as any)?.refId || ''),
          networkID: String((args as any)?.networkID || ''),
          userId: String((args as any)?.userId || ''),
          returnGatewayID: String((args as any)?.returnGatewayID || '').slice(0,8) + '…',
        });
        const refId = String(args.refId || '').trim();
        const returnGatewayID = String(args.returnGatewayID || '').trim();
        const networkID = String(args.networkID || '').trim();
        const botid = String(args.botid || '');
        const botType = String(args.botType || '');
        const groupID = String(args.groupID || '');
        const userIdRaw = String(args.userId || '').trim();
        const messageID = String(args.messageID || '');
        const message = String(args.message || '');

        if (!refId) return { status: 'failure', description: 'error: MISSING_FIELD refId' } as const;
        if (!returnGatewayID) return { status: 'failure', description: 'error: MISSING_FIELD returnGatewayID' } as const;
        const gatewayType = mapNetworkToGatewayType(networkID);
        if (!gatewayType) return { status: 'failure', description: 'error: UNKNOWN_NETWORK' } as const;

        const gateway = { npub: returnGatewayID, type: gatewayType } as const;
        const normalizedUser = passthroughUserId(gatewayType, userIdRaw);
        if (!normalizedUser) return { status: 'failure', description: 'error: INVALID_USER_ID' } as const;

        // Lookup mapping in local_npub_map
        const { getDB } = await import('../../db');
        const db = getDB();
        const row = db
          .query(`SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`)
          .get(gatewayType, returnGatewayID, normalizedUser) as any;
        const userNpub: string | null = row?.user_npub || null;
        console.log('[brain-cvm] mapping lookup', {
          networkID: gatewayType,
          userId: normalizedUser,
          mapped: !!userNpub,
        });

        if (!userNpub) {
          // No mapping — build a BeaconMessage with a response and let the CVM dispatcher send it.
          const setupText = 'we do not have an account for you setup';
          const rawPayload = { refId, returnGatewayID, networkID, botid, botType, groupID, userId: userIdRaw, messageID, message };
          const beacon = toBeaconMessage(rawPayload, gateway, {
            from: normalizedUser,
            messageId: messageID || undefined,
            text: message || undefined,
            hasMedia: false,
          });
          // Create outbound record now to track delivery status
          const { messageId: obMsgId, deliveryId } = createOutboundMessage({
            conversationId: refId,
            replyToMessageId: null,
            role: 'beacon',
            userNpub: null,
            content: { text: setupText, to: normalizedUser, quotedMessageId: null, beaconId: beacon.beaconID },
            metadata: { gateway, source: 'cvm_receive_unmapped' },
            channel: gatewayType,
          });
          beacon.meta = { ...(beacon.meta || {}), userNpub: null, ctx: { ...rawPayload, deliveryId, messageId: obMsgId } };
          beacon.response = { to: normalizedUser, text: setupText, quotedMessageId: null as any, gateway };
          enqueueBeacon(beacon);
          console.log('[brain-cvm] unmapped -> enqueued setup notice', { beaconID: beacon.beaconID });
          return { status: 'success', description: `insert refid ${refId}` } as const;
        }

        // Build BeaconMessage (generate new beaconID; keep original payload in meta.ctx)
        const rawPayload = {
          refId,
          returnGatewayID,
          networkID,
          botid,
          botType,
          groupID,
          userId: userIdRaw,
          messageID,
          message,
        };
        const beacon = toBeaconMessage(rawPayload, gateway, {
          from: normalizedUser,
          messageId: messageID || undefined,
          text: message || undefined,
          hasMedia: false,
        });
        beacon.meta = {
          ...(beacon.meta || {}),
          userNpub,
          ctx: { ...rawPayload },
        };

        // Persist inbound and remember routing, then enqueue for processing
        const inboundMessageId = recordInboundMessage(beacon);
        const { rememberInbound } = await import('../beacon_store');
        rememberInbound(beacon, inboundMessageId);
        enqueueBeacon(beacon);
        console.log('[brain-cvm] inbound -> enqueued beacon', { beaconID: beacon.beaconID });

        return { status: 'success', description: `insert refid ${refId}` } as const;
      } catch (err) {
        console.error('[brain-cvm] receiveMessage error', err);
        return { status: 'failure', description: 'error: INTERNAL' } as const;
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
