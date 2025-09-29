import { getEnv } from './types';
import { startWhatsAppAdapter } from './gateway/whatsapp/adapter';
import { startSignalAdapter } from './gateway/signal';
import { startNostrAdapter } from './gateway/nostr';
import { startMeshAdapter } from './gateway/mesh';
import { startBrainWorker } from './brain/worker';
import { getOutboundContext, forget } from './brain/beacon_store';

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
          enqueueOut({
            to: ctx.to,
            body: answer,
            quotedMessageId: ctx.quotedMessageId,
            gateway: ctx.gateway,
          });
          forget(beaconID);
          return json({ ok: true });
        } catch (err: any) {
          return json({ error: 'Failed to process webhook', details: String(err?.message || err) }, 500);
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`[start] modular runtime started; HTTP on :${port}`);
}

main();
