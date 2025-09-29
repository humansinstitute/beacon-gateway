import { getEnv } from './types';
import { startWhatsAppAdapter } from './gateway/whatsapp/adapter';
import { startSignalAdapter } from './gateway/signal';
import { startNostrAdapter } from './gateway/nostr';
import { startMeshAdapter } from './gateway/mesh';
import { startBrainWorker } from './brain/worker';

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

  console.log('[start] modular runtime started');
}

main();

