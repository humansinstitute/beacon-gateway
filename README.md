WhatsApp Web JS Gateway (Bun)

Minimal WhatsApp Web JS gateway using Bun. Provides QR login in terminal and a tiny HTTP API to inspect status and send messages.

Prerequisites
- Bun installed (`bun --version`)
- Chrome/Chromium available for Puppeteer (or Puppeteer will download Chromium on first run)

Setup
1) Install dependencies:
   bun install

2) Run the unified gateway (queues + HTTP):
   GATEWAY_NPUB=npub1yourkey bun run src/start-gateway.ts

3) Alternatively, run the basic HTTP-only gateway:
   bun run src/index.js

4) Or run the queue-only client (no HTTP):
   GATEWAY_NPUB=npub1yourkey bun run src/whatsapp-gateway-queue.ts

3) Scan the QR shown in the terminal with the WhatsApp app.

Environment variables (optional)
- `PORT` (default: 3000) — can be set in `.env`
- `SESSION_DIR` (default: .wwebjs_auth)
- `HEADLESS` (default: true) — set to `false` to see the browser UI (useful for debugging)
 - `NO_SANDBOX` (default: false) — set `true` in Docker/CI if sandbox issues arise
 - `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN` — use a system Chrome/Chromium instead of downloaded one
 - `GATEWAY_NPUB` — required for the queue client; nostr npub of this gateway
- `NO_SANDBOX` (default: false) — set `true` in Docker/CI if sandbox issues arise
- `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN` — use a system Chrome/Chromium instead of downloaded one

.env support
- Bun automatically loads `.env` for `bun run`.
- Create a `.env` file in the project root, for example:

  PORT=4000
  SESSION_DIR=.wwebjs_auth
  HEADLESS=true

HTTP API
- GET `/` — Returns gateway status
  Example: { "status": "INITIALIZING" | "QR" | "READY" | "DISCONNECTED" | "AUTH_FAIL" }

- GET `/qr` — Returns last QR (raw string) when status = `QR`
  Example: { "qr": "...", "status": "QR" }

- POST `/send` — Send a text and/or media message
  Body (JSON):
  {
    "to": "+15551234567" | "15551234567" | "15551234567@c.us",
    "message": "hello there",
    "mediaBase64": "<optional base64 payload>",
    "mediaMime": "image/png" | "application/octet-stream" | ...
  }
  Notes:
  - `to` accepts digits, `+` prefixed digits, or a full WhatsApp JID (`@c.us`).
  - Either `message` or `mediaBase64` must be provided.

Common tasks
- Logout/clear session: delete the `SESSION_DIR` (default `.wwebjs_auth`) and restart.
- Run headful browser for debugging: `HEADLESS=false bun run src/index.js`

Caveats
- Puppeteer downloads Chromium on first install; this can take a few minutes.
- This is a minimal gateway; harden and monitor for production use (health checks, retries, metrics, storage for logs, etc.).

Troubleshooting
- Repeated `Client disconnected: LOGOUT`:
  - Phone likely invalidated the web session or another device took over. A fresh QR should appear; scan again.
  - If it loops, remove the session folder: `rm -rf .wwebjs_auth` (or set a new `SESSION_DIR`) and restart.
- `Execution context was destroyed` during navigation:
  - Usually harmless; the app now catches and logs it. If persistent, try `HEADLESS=false` to observe the web UI.
  - Consider using system Chrome: set `PUPPETEER_EXECUTABLE_PATH=/path/to/Chrome`.
- Sandbox errors in containerized environments: set `NO_SANDBOX=true`.

Queue-based gateway (p-queue)
- File: `src/whatsapp-gateway-queue.ts` implements two queues:
  - `GATEWAY_IN` for inbound message processing
  - `GATEWAY_OUT` for outbound sending
- Tagging: all queue items include `{ gateway: { npub: GATEWAY_NPUB, type: 'whatsapp' } }`.
- Tuning: adjust `concurrency`, `interval`, and `intervalCap` for each queue.
- Extensibility: implement your own business logic in `processIncomingMessage`.

Message Flow

  ┌───────────────────────────────┐
  │         WhatsApp User         │
  └───────────────┬───────────────┘
                  │
                  ▼
  ┌───────────────────────────────┐
  │      WhatsApp Web API         │
  │       (web.whatsapp.com)      │
  └───────────────┬───────────────┘
                  │ (Puppeteer/Chromium)
                  ▼
  ┌───────────────────────────────┐
  │     whatsapp-web.js Client    │
  │        (LocalAuth/Events)     │
  └───────────────┬───────────────┘
                  │ emits
                  ▼
  ┌───────────────────────────────┐
  │     client.on('message')      │
  │   ├─ Create GatewayInData     │
  │   └─ GATEWAY_IN.add()         │
  └───────────────┬───────────────┘
                  │ dequeues (rate-limited)
                  ▼
  ┌───────────────────────────────┐
  │  processIncomingMessage(...)  │
  │  ├─ enrich/log                │
  │  └─ business logic            │
  └───────────────┬───────────────┘
                  │ optional reply/forward
                  ▼
  ┌───────────────────────────────┐
  │  ├─ Create GatewayOutData     │
  │  └─ GATEWAY_OUT.add()         │
  └───────────────┬───────────────┘
                  │ dequeues (rate-limited)
                  ▼
  ┌───────────────────────────────┐
  │   sendMessage → client.send   │
  └───────────────┬───────────────┘
                  │
                  ▼
  ┌───────────────────────────────┐
  │      WhatsApp Recipient       │
  └───────────────────────────────┘

Usage Examples

Example 1: Basic Setup

```typescript
import WhatsAppGatewayClient from './whatsapp-gateway-queue';

const gateway = new WhatsAppGatewayClient();
await gateway.initialize();

// Queue stats
console.log(gateway.getQueueStats());
```

Example 2: Send Outgoing Message

```typescript
await gateway.queueOutgoingMessage({
  data: {
    to: '1234567890@c.us',
    body: 'Hello from gateway!'
  },
  gateway: gateway.getGatewayInfo()
});
```

Example 3: Reply to Message

```typescript
await gateway.queueOutgoingMessage({
  data: {
    to: '1234567890@c.us',
    body: 'This is a reply',
    quotedMessageId: 'original-message-id'
  },
  gateway: gateway.getGatewayInfo(),
  originalMessageId: 'original-message-id'
});
```

Testing Checklist
- [ ] GATEWAY_NPUB environment variable is set
- [ ] WhatsApp QR code authentication works
- [ ] Incoming messages are added to GATEWAY_IN queue
- [ ] Messages are processed with correct gateway identifier
- [ ] GATEWAY_OUT queue sends messages successfully
- [ ] Rate limiting works as expected
- [ ] Error handling works for failed messages
- [ ] Graceful shutdown works correctly
- [ ] Queue stats are accurate
- [ ] Multiple concurrent messages handled properly

Success Criteria
- All incoming WhatsApp messages flow through GATEWAY_IN
- All outgoing messages flow through GATEWAY_OUT
- Gateway identifier includes correct npub from env
- Rate limiting prevents API abuse
- Concurrent processing improves throughput
- Error handling prevents queue blocking
- Graceful shutdown preserves message integrity

Related Documentation
- p-queue: https://github.com/sindresorhus/p-queue
- whatsapp-web.js Guide: https://wwebjs.dev/guide/
- Message object: https://docs.wwebjs.dev/Message.html

Labels
`enhancement` `queue` `whatsapp` `gateway` `p-queue` `typescript`

Assignees
- [ ] Assign developer
- [ ] Assign reviewer

Timeline
- Estimated Time: 4–6 hours
- Priority: Medium
