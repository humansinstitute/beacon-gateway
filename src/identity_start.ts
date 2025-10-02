import { getEnv } from './types';
import { startWhatsAppAdapter } from './gateway/whatsapp/adapter';
import { startSignalAdapter } from './gateway/signal';
import { startNostrAdapter } from './gateway/nostr';
import { startMeshAdapter } from './gateway/mesh';
import { startCvmServer } from './identity/cvm';
import { startIdentityWorker } from './identity/worker';
import { startOnlineAdapter } from './gateway/online';
import { enqueueIdentityBeacon, consumeIdentityOut } from './identity/queues';

function main() {
  const npub = getEnv('GATEWAY_NPUB', '');
  if (!npub) {
    console.warn('[identity_start] GATEWAY_NPUB is not set; WhatsApp adapter will still run but outbound filtering may be broad');
  }

  // Start gateways, injecting the identity-specific queues for both inbound and outbound messages
  startWhatsAppAdapter({
    enqueueBeacon: enqueueIdentityBeacon,
    consumeOut: consumeIdentityOut,
  });
  startSignalAdapter(); // Note: Other adapters could be refactored similarly if needed
  startNostrAdapter();
  startMeshAdapter();

  // Start CVM server
  startCvmServer().catch(err => {
    console.error('[CVM] Failed to start CVM server:', err);
    process.exit(1);
  });

  // Start identity worker
  startIdentityWorker();
  // Online adapter for Identity path -> online_id
  startOnlineAdapter({ type: 'online_id' });

  // Minimal HTTP server for health
  const port = parseInt(getEnv('PORT', '3010') || '3010', 10);

  const json = (data: any, code = 200) => new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

  Bun.serve({
    port,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);

      if (pathname === '/' || pathname === '/health') {
        return json({ ok: true, service: 'beacon-identity', npub });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`[identity_start] Identity service started; HTTP on :${port}`);
}

main();
