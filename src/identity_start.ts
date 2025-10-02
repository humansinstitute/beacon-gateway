import { getEnv } from './types';
import { startWhatsAppAdapter } from './gateway/whatsapp/adapter';
import { startWebAdapter } from './gateway/web/index';
import { startSignalAdapter } from './gateway/signal';
import { startNostrAdapter } from './gateway/nostr';
import { startMeshAdapter } from './gateway/mesh';
import { startCvmServer } from './identity/cvm';
import { startIdentityWorker } from './identity/worker';
import { enqueueIdentityBeacon, consumeIdentityOut } from './identity/queues';

function main() {
  const npub = getEnv('GATEWAY_NPUB', '');
  if (!npub) {
    console.warn('[identity_start] GATEWAY_NPUB is not set; WhatsApp adapter will still run but outbound filtering may be broad');
  }
  // Feature flags for Identity service only
  const enableWhatsApp = (() => {
    const v = (getEnv('BEACON_ID_WHATSAPP', 'true') || '').toLowerCase().trim();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  })();
  const enableWeb = (() => {
    const v = (getEnv('BEACON_ID_WEB', 'false') || '').toLowerCase().trim();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  })();

  // Start gateways (Identity scope), injecting identity-specific queues
  if (enableWhatsApp) {
    startWhatsAppAdapter({
      enqueueBeacon: enqueueIdentityBeacon,
      consumeOut: consumeIdentityOut,
    });
  } else {
    console.log('[identity_start] WhatsApp adapter disabled via BEACON_ID_WHATSAPP');
  }
  if (enableWeb) {
    startWebAdapter({
      enqueueBeacon: enqueueIdentityBeacon,
      consumeOut: consumeIdentityOut,
    });
  } else {
    console.log('[identity_start] Web adapter disabled via BEACON_ID_WEB');
  }
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

  // Minimal HTTP server for health
  const port = parseInt(getEnv('PORTID', '3011') || '3011', 10);

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