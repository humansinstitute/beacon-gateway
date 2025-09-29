/**
 * Start both: WhatsApp queue client + HTTP server
 *
 * Single entrypoint to run the queued gateway and expose HTTP endpoints
 * for status, QR, queue stats, and sending messages via the OUT queue.
 *
 * Usage:
 *   - bun run src/start-gateway.ts
 *   - or `bun run start:all`
 */

import WhatsAppGatewayClient from './whatsapp-gateway-queue';

// Env helper (supports Bun.env and process.env)
const getEnv = (key: string, fallback?: string): string | undefined => {
  const bunVal = (typeof Bun !== 'undefined' ? (Bun.env as any)?.[key] : undefined);
  const nodeVal = (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return bunVal ?? nodeVal ?? fallback;
};

const PORT = parseInt(getEnv('PORT', '3000')!, 10);

// Track client status + last QR for HTTP exposure
let status: 'INITIALIZING' | 'QR' | 'READY' | 'DISCONNECTED' | 'AUTH_FAIL' | 'INIT_ERROR' = 'INITIALIZING';
let lastQR: string | null = null;

function normalizeToJid(to: string | undefined | null) {
  if (!to) return null;
  if (to.endsWith('@c.us') || to.endsWith('@g.us')) return to;
  const digits = to.replace(/\D/g, '');
  return `${digits}@c.us`;
}

async function main() {
  const gateway = new WhatsAppGatewayClient();
  const client = gateway.getClient();

  // Mirror key events into a simple status we can return over HTTP
  client.on('qr', (qr: string) => {
    lastQR = qr;
    status = 'QR';
  });
  client.on('ready', () => { status = 'READY'; });
  client.on('authenticated', () => { /* noop; READY will follow */ });
  client.on('auth_failure', () => { status = 'AUTH_FAIL'; });
  client.on('disconnected', () => { status = 'DISCONNECTED'; });

  // Start WhatsApp gateway (prints QR on first run)
  await gateway.initialize();

  // Minimal JSON helper
  const json = (data: any, code = 200) => new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

  // HTTP server with status, qr, queue stats, and send endpoints
  Bun.serve({
    port: PORT,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);

      if (pathname === '/') {
        return json({
          status,
          gateway: gateway.getGatewayInfo(),
          queues: gateway.getQueueStats(),
        });
      }

      if (pathname === '/health') {
        return json({ ok: status === 'READY', status });
      }

      if (pathname === '/qr') {
        return json({ status, qr: status === 'QR' ? lastQR : null });
      }

      if (pathname === '/queue/stats') {
        return json(gateway.getQueueStats());
      }

      if (pathname === '/send' && req.method === 'POST') {
        try {
          const body = await req.json().catch(() => null) as any;
          if (!body) return json({ error: 'Invalid JSON' }, 400);

          const to = normalizeToJid(body.to);
          const message = String(body.message || '').trim();
          const quotedMessageId = body.quotedMessageId || undefined;

          if (!to || !message) return json({ error: "'to' and 'message' are required" }, 400);

          await gateway.queueOutgoingMessage({
            data: { to, body: message, quotedMessageId },
            gateway: gateway.getGatewayInfo(),
          });
          return json({ ok: true });
        } catch (err: any) {
          return json({ error: 'Failed to enqueue send', details: String(err?.message || err) }, 500);
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`Gateway HTTP listening on http://localhost:${PORT}`);

  // Graceful shutdown
  if (typeof process !== 'undefined') {
    process.on('SIGINT', async () => { await gateway.shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await gateway.shutdown(); process.exit(0); });
    process.on('unhandledRejection', (r) => console.error('UnhandledRejection:', r));
    process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Fatal error:', e);
    status = 'INIT_ERROR';
  });
}

