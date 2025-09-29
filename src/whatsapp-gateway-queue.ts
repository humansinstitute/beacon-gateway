/**
 * WhatsApp Gateway with p-queue (Bun + TypeScript)
 *
 * Heavily commented reference implementation that:
 * - Creates two queues: GATEWAY_IN (incoming processing) and GATEWAY_OUT (outgoing sending)
 * - Integrates with whatsapp-web.js Client
 * - Uses an env-provided gateway identifier (npub) to tag all messages
 * - Applies rate limiting and concurrency controls via p-queue
 *
 * Run:
 *   - Put GATEWAY_NPUB in your .env (see .env.example)
 *   - bun run src/whatsapp-gateway-queue.ts
 *   - Scan the QR code in your terminal
 */
/**
 * Message Flow (Inbound → Outbound)
 *
 *   ┌───────────────────────────────┐
 *   │     whatsapp-web.js Client    │
 *   │         (LocalAuth)           │
 *   └───────────────┬───────────────┘
 *                   │ emits
 *                   ▼
 *   ┌───────────────────────────────┐
 *   │     client.on('message')      │
 *   │   ├─ Create GatewayInData     │  ← wraps Message + { npub, type }
 *   │   └─ GATEWAY_IN.add()         │  ← enqueue with priority
 *   └───────────────┬───────────────┘
 *                   │ dequeues (rate-limited)
 *                   ▼
 *   ┌───────────────────────────────┐
 *   │  processIncomingMessage(...)  │
 *   │  ├─ enrich/log                │
 *   │  └─ business logic            │  ← webhook/DB/commands/etc.
 *   └───────────────┬───────────────┘
 *                   │ optional reply/forward
 *                   ▼
 *   ┌───────────────────────────────┐
 *   │  ├─ Create GatewayOutData     │  ← { to, body, quotedMessageId? } + gateway
 *   │  └─ GATEWAY_OUT.add()         │
 *   └───────────────┬───────────────┘
 *                   │ dequeues (rate-limited)
 *                   ▼
 *   ┌───────────────────────────────┐
 *   │  sendMessage → client.send    │
 *   └───────────────┬───────────────┘
 *                   │
 *                   ▼
 *   ┌───────────────────────────────┐
 *   │      WhatsApp Recipient       │
 *   └───────────────────────────────┘
 */

import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import PQueue from 'p-queue';
import qrcode from 'qrcode-terminal';

// ==================== Env Helpers ====================
// Bun automatically loads .env for `bun run`.
// We support both Bun.env and process.env for portability.
const getEnv = (key: string, fallback?: string): string | undefined => {
  const bunVal = (typeof Bun !== 'undefined' ? Bun.env?.[key] : undefined);
  const nodeVal = (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return bunVal ?? nodeVal ?? fallback;
};

// Required identifier used to tag all messages flowing through the gateway.
const GATEWAY_NPUB = getEnv('GATEWAY_NPUB', '') as string;
if (!GATEWAY_NPUB) {
  throw new Error('GATEWAY_NPUB environment variable is required');
}

// Optional runtime controls for Puppeteer/Chrome
const HEADLESS = (getEnv('HEADLESS', 'true')!.toLowerCase() !== 'false');
const NO_SANDBOX = (getEnv('NO_SANDBOX', 'false')!.toLowerCase() === 'true');
const EXECUTABLE_PATH = getEnv('PUPPETEER_EXECUTABLE_PATH', getEnv('CHROME_BIN'));

// Prefer a human-friendly contact name; avoid the generic label "WhatsApp User"
function resolveContactName(contact?: any) {
  const candidate = (contact?.pushname || contact?.name || contact?.verifiedName || contact?.shortName || '').trim();
  if (candidate && candidate !== 'WhatsApp User') return candidate;
  return contact?.number || contact?.id?.user || 'unknown';
}

// ==================== Type Definitions ====================

// Lightweight gateway identity that accompanies every queued item
export interface GatewayIdentifier {
  npub: string;      // Nostr public key of this gateway
  type: 'whatsapp';  // Static type tag for downstream routing
}

// Incoming queue payload: carries the full WhatsApp Message object
export interface GatewayInData {
  data: Message;               // Original whatsapp-web.js Message
  gateway: GatewayIdentifier;  // Identity metadata
}

// Outgoing queue payload: minimal info to send a message
export interface GatewayOutData {
  data: {
    to: string;                // WhatsApp JID (e.g., 15551234567@c.us)
    body: string;              // Text body
    quotedMessageId?: string;  // Optional: reply threading
  };
  gateway: GatewayIdentifier;  // Identity metadata
  originalMessageId?: string;  // Optional: correlate to an inbound message
}

// ==================== Queue Setup ====================
// Two independent queues so ingestion does not block sending (and vice versa).
// Tune concurrency and rate limits to your infra and WhatsApp usage patterns.

export const GATEWAY_IN = new PQueue({
  concurrency: 5,   // up to 5 concurrent inbound processors
  interval: 1000,   // 1-second token bucket window
  intervalCap: 10,  // at most 10 tasks started per window
});

export const GATEWAY_OUT = new PQueue({
  concurrency: 3,   // up to 3 concurrent outbound sends
  interval: 1000,   // 1-second token bucket window
  intervalCap: 5,   // at most 5 tasks started per window
});

// Basic queue monitoring to help with observability during development.
GATEWAY_IN.on('active', () => {
  console.log(`📥 [GATEWAY_IN] Active: running=${GATEWAY_IN.pending} queued=${GATEWAY_IN.size}`);
});
GATEWAY_OUT.on('active', () => {
  console.log(`📤 [GATEWAY_OUT] Active: running=${GATEWAY_OUT.pending} queued=${GATEWAY_OUT.size}`);
});
GATEWAY_IN.on('error', (error) => console.error('❌ [GATEWAY_IN] Error:', error));
GATEWAY_OUT.on('error', (error) => console.error('❌ [GATEWAY_OUT] Error:', error));

// ==================== WhatsApp Gateway Client ====================

export class WhatsAppGatewayClient {
  // Underlying WhatsApp client instance
  private client: Client;
  // Immutable gateway identifier
  private readonly gatewayNpub: string;
  // Runtime flag to ensure we only queue outbound work when ready
  private isReady = false;

  constructor() {
    // Persist identity
    this.gatewayNpub = GATEWAY_NPUB;

    // Puppeteer args tailored for server environments; add --no-sandbox only when required
    const pupArgs = [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=site-per-process,Translate,BackForwardCache',
    ];
    if (NO_SANDBOX) pupArgs.push('--no-sandbox', '--disable-setuid-sandbox');

    // Initialize whatsapp-web.js with a persistent LocalAuth (stores session under .wwebjs_auth)
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: 'gateway-whatsapp' }),
      puppeteer: {
        headless: HEADLESS,
        args: pupArgs,
        executablePath: EXECUTABLE_PATH,
      },
    });

    this.setupEventHandlers();
  }

  // Hook client lifecycle and message events.
  private setupEventHandlers() {
    // QR Code: printed in terminal for easy scanning with your phone
    this.client.on('qr', (qr) => {
      console.log('📱 QR Code received. Scan with WhatsApp:');
      try { qrcode.generate(qr, { small: true }); } catch { console.log(qr); }
    });

    // High-level progress and state logs
    this.client.on('loading_screen', (percent, message) => {
      console.log('⌛ loading:', percent, message);
    });
    this.client.on('authenticated', () => console.log('✅ Authenticated'));
    this.client.on('auth_failure', (msg) => console.error('❌ Authentication failed:', msg));

    // Ready: start allowing outbound queuing
    this.client.on('ready', () => {
      this.isReady = true;
      console.log('✅ WhatsApp Gateway Client is ready!');
      console.log(`🔑 Gateway NPUB: ${this.gatewayNpub}`);
      this.startOutgoingProcessor();
    });

    // Disconnected: mark not-ready; higher-level supervisors can restart if desired
    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      console.warn('⚠️ Client disconnected:', reason);
    });

    // Every incoming message is enqueued to the inbound queue for processing
    this.client.on('message', async (message: Message) => {
      await this.handleIncomingMessage(message);
    });
  }

  // ==================== Incoming Message Path ====================

  private async handleIncomingMessage(message: Message) {
    try {
      const gatewayInData: GatewayInData = {
        data: message, // Carry the full message; downstream can fetch contact/chat if needed
        gateway: { npub: this.gatewayNpub, type: 'whatsapp' },
      };

      // Prioritize messages not from self (avoid feedback loops)
      const priority = message.fromMe ? 0 : 1;

      await GATEWAY_IN.add(async () => {
        await this.processIncomingMessage(gatewayInData);
      }, { priority });
    } catch (error) {
      console.error('❌ Error queueing incoming message:', error);
    }
  }

  // Business-logic entry point for inbound messages.
  // Replace/extend this with your application logic (DB writes, webhooks, command router, etc.).
  private async processIncomingMessage(data: GatewayInData) {
    const msg = data.data;

    // Lightweight enrichment for logging/observability
    const contact = await msg.getContact().catch(() => undefined);
    const chat = await msg.getChat().catch(() => undefined);
    const preview = (msg.body || '').slice(0, 80);

    console.log('📨 [GATEWAY_IN] Processing message:', {
      from: msg.from,
      contact: resolveContactName(contact),
      chat: chat?.name || (msg.from.endsWith('@g.us') ? 'Group' : 'Direct'),
      body: preview + (msg.body && msg.body.length > 80 ? '…' : ''),
      hasMedia: msg.hasMedia,
      gateway: data.gateway,
    });

    // ============================================
    // TODO: Implement your business logic here
    // - Forward to external API
    // - Persist to database
    // - Command processing
    // - Workflow triggers, etc.
    // ============================================

    // Example echo-bot behavior: reply when body starts with !echo
    if (msg.body?.startsWith('!echo ')) {
      const echoText = msg.body.substring(6);
      await this.queueOutgoingMessage({
        data: {
          to: msg.from, // Reply back to sender
          body: `🔊 ${echoText}`,
          quotedMessageId: msg.id._serialized, // Keep threading in the UI
        },
        gateway: data.gateway,
        originalMessageId: msg.id._serialized,
      });
    }
  }

  // ==================== Outgoing Message Path ====================

  private startOutgoingProcessor() {
    // Nothing to start explicitly; p-queue pulls as items are added.
    // This log exists to make the lifecycle explicit and discoverable.
    console.log('📤 [GATEWAY_OUT] Processor ready — queue messages via queueOutgoingMessage(...)');
  }

  /**
   * Public method to enqueue a message for sending.
   * Safe to call from anywhere in your app once the client is ready.
   */
  public async queueOutgoingMessage(data: GatewayOutData): Promise<void> {
    if (!this.isReady) throw new Error('WhatsApp client is not ready');
    await GATEWAY_OUT.add(async () => {
      await this.sendMessage(data);
    });
  }

  // Actual send operation (runs inside the GATEWAY_OUT queue)
  private async sendMessage(data: GatewayOutData) {
    try {
      console.log(`📤 [GATEWAY_OUT] Sending message to ${data.data.to}`);

      const options: any = {};
      if (data.data.quotedMessageId) options.quotedMessageId = data.data.quotedMessageId;

      await this.client.sendMessage(data.data.to, data.data.body, options);

      console.log('✅ [GATEWAY_OUT] Message sent', {
        to: data.data.to,
        originalId: data.originalMessageId,
        gateway: data.gateway,
      });
    } catch (error) {
      console.error('❌ [GATEWAY_OUT] Failed to send message:', error);
      throw error; // Keep p-queue aware of failures for retries/metrics upstream
    }
  }

  // ==================== Lifecycle Methods ====================

  public async initialize() {
    console.log('🚀 Initializing WhatsApp Gateway Client...');
    await this.client.initialize();
  }

  public async shutdown() {
    console.log('🛑 Shutting down WhatsApp Gateway Client...');
    await this.client.destroy();
  }

  // ==================== Public Getters ====================

  public getClient(): Client { return this.client; }

  public getGatewayInfo(): GatewayIdentifier {
    return { npub: this.gatewayNpub, type: 'whatsapp' };
  }

  public getQueueStats() {
    return {
      gatewayIn: { pending: GATEWAY_IN.pending, queued: GATEWAY_IN.size },
      gatewayOut: { pending: GATEWAY_OUT.pending, queued: GATEWAY_OUT.size },
    };
  }
}

// ==================== Main Entry Point ====================
// Provides a simple runnable binary for local development & testing.

async function main() {
  const gateway = new WhatsAppGatewayClient();

  // Graceful shutdown for Ctrl+C or container stops
  if (typeof process !== 'undefined') {
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await gateway.shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await gateway.shutdown();
      process.exit(0);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('UnhandledRejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('UncaughtException:', err);
    });
  }

  // Start the WhatsApp client
  await gateway.initialize();

  // Example: Programmatic send after 10s (disabled by default)
  // setTimeout(async () => {
  //   await gateway.queueOutgoingMessage({
  //     data: { to: '1234567890@c.us', body: 'Hello from gateway!' },
  //     gateway: gateway.getGatewayInfo(),
  //   });
  // }, 10000);
}

// Run only if executed directly (not when imported)
// Bun sets import.meta.main to true for the entrypoint module.
if (import.meta.main) {
  main().catch(console.error);
}

export default WhatsAppGatewayClient;
