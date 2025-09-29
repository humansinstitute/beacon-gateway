Beacon - Main 

# Beacon: A protocol to provide a gateway to freedom tech

![freedom_tech_meme](https://github.com/user-attachments/assets/622123cc-86e0-4365-9bbf-73d2ffe56685)

### Why Beacon? 

> On the island of Pharos the Ptolemies lit a beacon that turned Alexandria into the nerve-centre of the ancient world, guiding mariners safely into the port of liberty, knowledge and freedom. 
> With free acess to information we can find our own solutions and build our own freedom. The library of Alexandria once represented this freedom but was lost to time. 
> The goal of the project is to relight a similar flame on the internet. To take closed, controlled networks and guide people towards free information, free networks and freedom money.
>
> Wherever a handset can send a text, Beacon can deliver knowledge, coordination, and untraceable freedom money.
> The tower is gone; but the light will remain.

Beacon is intended to be an open protocol to allow communities to offer access to freedom tech, with no on device install and minimal barrier to entry inside applications you already use.

A trojan horse for freedom tech.

### Purpose

The purpose of beacon is not to be "the wallet to end them all" it is to provide a pragmatic entry point.

It was born out of an initial frustration of trying to deliver sophisticated apps in places where the regular user couldn't afford internet, the internet was bad when they did have it, smartphones barely existed and the only single thing that ever worked reliably was WhatsApp.

Turns out Zuckerberg already pays for subsidized access to a limited, controlled pastiche of the internet. so lets put some freedom tech in it.

-----

Prerequisites
- Bun installed (`bun --version`)
- Chrome/Chromium available for Puppeteer (or Puppeteer will download Chromium on first run)

Setup
1) Install dependencies:
   bun install

2) Start everything (gateway + brain + webhook server):
   GATEWAY_NPUB=npub1yourkey bun run start:all

3) Scan the QR shown in the terminal with the WhatsApp app.

Environment
- `PORT` (default: 3009) — orchestrator HTTP port
- `SESSION_DIR` (default: .wwebjs_auth)
- `HEADLESS` (default: true) — set `false` for headful browser
- `NO_SANDBOX` (default: false) — set `true` for Docker/CI
- `PUPPETEER_EXECUTABLE_PATH` or `CHROME_BIN` — use system Chrome
- `GATEWAY_NPUB` — npub tag for this gateway (required)
- `OPENROUTER_API_KEY` — for default AI responses
- `WINGMAN_API_URL` and `WINGMAN_API_TOKEN` — Wingman trigger endpoint and token
- `WEBHOOK_BASE_URL` (optional) — base URL for webhook in prompts (default http://localhost:PORT)

.env support
- Bun automatically loads `.env` for `bun run`.
- Create a `.env` file in the project root, for example:

  PORT=4000
  SESSION_DIR=.wwebjs_auth
  HEADLESS=true

HTTP API (orchestrator)
- GET `/` or `/health` — { ok: true, service, npub }
- POST `/api/webhook/wingman_response` — body: { body: string, beaconID: string }
  - Routes the answer back to the original sender via WhatsApp
  - Sanitizes control characters and collapses whitespace

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

Brain + Intent Routing
- Worker: `src/brain/worker.ts` consumes Beacon envelopes and routes intents
- Router: `src/brain/intent_router.ts`
  - If any of the first 5 words include "wingman" → triggers Wingman
  - Otherwise uses OpenRouter via `src/brain/callAI.util.ts` and conversation agent

Wingman Integration
- Trigger: `src/brain/wingman.client.ts` posts to `WINGMAN_API_URL` with a compact JSON prompt
- Webhook: `/api/webhook/wingman_response` accepts { body, beaconID } and replies to the right chat
- Context mapping: `src/brain/beacon_store.ts` remembers inbound routing (to, quotedMessageId, gateway)

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
