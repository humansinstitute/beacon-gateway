import { getEnv } from './types';
import { startWhatsAppAdapter } from './gateway/whatsapp/adapter';
import { startSignalAdapter } from './gateway/signal';
import { startNostrAdapter } from './gateway/nostr';
import { startMeshAdapter } from './gateway/mesh';
import { startWebAdapter } from './gateway/web';
import { startBrainWorker } from './brain/worker';
import { getOutboundContext, forget } from './brain/beacon_store';
import { logAction, createOutboundMessage } from './db';

function main() {
  const npub = getEnv('GATEWAY_NPUB', '');
  if (!npub) {
    console.warn('[start] GATEWAY_NPUB is not set; WhatsApp adapter will still run but outbound filtering may be broad');
  }

  // Start gateways
  startWhatsAppAdapter();
  startSignalAdapter();
  startNostrAdapter();
  startMeshAdapter();
  startWebAdapter();

  // Start brain worker
  startBrainWorker();


  // Minimal HTTP server for health and webhooks
  const port = parseInt(getEnv('PORT', '3009') || '3009', 10);

  const json = (data: any, code = 200) => new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

  // Normalize answer text: drop control chars and collapse whitespace to single space
  const sanitizeAnswer = (s: string) =>
    (s || '')
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  Bun.serve({
    port,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);

      if (pathname === '/' || pathname === '/health') {
        return json({ ok: true, service: 'beacon-orchestrator', npub });
      }

      if ((pathname === '/api/webhook/wingman_response' || pathname === '/api/webhook/wingmanresponse') && req.method === 'POST') {
        try {
          const body = await req.json().catch(() => null) as any;
          if (!body) return json({ error: 'Invalid JSON' }, 400);
          const answer = sanitizeAnswer((body.body ?? body.message ?? '').toString());
          const beaconID = (body.beaconID ?? body.beaconId ?? body.beacon_id ?? '').toString();
          if (!answer || !beaconID) return json({ error: "'body' and 'beaconID' are required" }, 400);

          const ctx = getOutboundContext(beaconID);
          if (!ctx) return json({ error: 'Unknown beaconID' }, 404);

          // Emit to outbound queue; gateway adapters will send
          const { enqueueOut } = await import('./queues');
          // Persist outbound message + delivery (queued) for history
          const { createOutboundMessage } = await import('./db');
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: ctx.conversationId || '',
            replyToMessageId: ctx.inboundMessageId || null,
            role: 'beacon',
            userNpub: ctx.userNpub || null,
            content: {
              text: answer,
              to: ctx.to,
              quotedMessageId: ctx.quotedMessageId,
              beaconId: beaconID,
            },
            metadata: { gateway: ctx.gateway, source: 'wingman_webhook' },
            channel: ctx.gateway.type,
          });

          enqueueOut({
            to: ctx.to,
            body: answer,
            quotedMessageId: ctx.quotedMessageId,
            deliveryId,
            messageId,
            gateway: ctx.gateway,
          });
          logAction(beaconID, 'webhook_received', { body: answer }, 'ok');
          logAction(beaconID, 'outbound_sent', { to: ctx.to, gateway: ctx.gateway, quotedMessageId: ctx.quotedMessageId, body: answer }, 'ok');
          forget(beaconID);
          return json({ ok: true });
        } catch (err: any) {
          return json({ error: 'Failed to process webhook', details: String(err?.message || err) }, 500);
        }
      }

      // Minimal Messages API
      if (pathname === '/messages' && req.method === 'POST') {
        try {
          const body = await req.json();
          const direction = (body.direction || 'outbound').toString();
          if (direction !== 'outbound' && direction !== 'inbound') return json({ error: 'direction must be inbound|outbound' }, 400);
          const conversationId = (body.conversationId || '').toString();
          if (!conversationId) return json({ error: 'conversationId is required' }, 400);
          const replyToMessageId = body.replyToMessageId ? String(body.replyToMessageId) : null;
          const role = (body.role || (direction === 'inbound' ? 'user' : 'beacon')).toString();
          const content = body.content || {};
          const attachments = body.attachments || null;
          const metadata = body.metadata || {};
          if (direction === 'inbound') {
            const { recordInboundMessage } = await import('./db');
            const messageId = recordInboundMessage({
              beaconID: content.beaconId || '',
              source: {
                gateway: metadata.gateway || { npub, type: 'whatsapp' },
                from: content.from,
                messageId: content.providerMessageId,
                text: content.text,
                hasMedia: !!attachments,
                messageData: JSON.stringify({ content, attachments, metadata }),
              },
              meta: { conversationID: conversationId },
            } as any);
            return json({ messageId });
          }
          const channel = (metadata?.gateway?.type || body.channel || '').toString();
          if (!channel) return json({ error: 'channel is required in metadata.gateway.type or body.channel' }, 400);
          const { createOutboundMessage } = await import('./db');
          const res = createOutboundMessage({
            conversationId,
            replyToMessageId,
            role: role as any,
            content,
            metadata,
            channel,
          });
          return json(res, 201);
        } catch (err: any) {
          return json({ error: 'Failed to create message', details: String(err?.message || err) }, 500);
        }
      }

      if (pathname.startsWith('/conversations/') && pathname.endsWith('/messages') && req.method === 'GET') {
        const conversationId = pathname.split('/')[2];
        const url = new URL(req.url);
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const before = url.searchParams.get('before') ? parseInt(url.searchParams.get('before')!, 10) : undefined;
        const after = url.searchParams.get('after') ? parseInt(url.searchParams.get('after')!, 10) : undefined;
        const { getConversationMessages } = await import('./db');
        const items = getConversationMessages(conversationId, limit, before, after);
        return json({ items });
      }

      if (pathname.startsWith('/messages/') && req.method === 'GET') {
        const id = pathname.split('/')[2];
        const { getMessageById, getReplies, getDeliveryById } = await import('./db');
        const message = getMessageById(id);
        if (!message) return json({ error: 'Not found' }, 404);
        const replies = getReplies(id);
        return json({ message, replies });
      }

      if (pathname.startsWith('/deliveries/') && pathname.endsWith('/transition') && req.method === 'POST') {
        try {
          const parts = pathname.split('/');
          const id = parts[2];
          const body = await req.json();
          const status = String(body.status);
          const allowed = ['sent', 'failed', 'canceled'];
          if (!allowed.includes(status)) return json({ error: 'invalid status' }, 400);
          const { transitionDelivery } = await import('./db');
          transitionDelivery(id, status as any, {
            providerMessageId: body.providerMessageId,
            errorCode: body.errorCode,
            errorMessage: body.errorMessage,
          });
          return json({ ok: true });
        } catch (err: any) {
          return json({ error: 'Failed to transition', details: String(err?.message || err) }, 500);
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`[start] modular runtime started; HTTP on :${port}`);
}

main();
