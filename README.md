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

Turns out Zuckerberg already pays for subsidized access to a limited, controlled pastiche of the internet. so lets put some freedom tech in i

-----

Prerequisites
- Bun installed (`bun --version`)
- Chrome/Chromium available for Puppeteer (or Puppeteer will download Chromium on first run)

Setup
1) Install dependencies:
   bun install

2) Start everything (gateways + brain + HTTP):
   GATEWAY_NPUB=npub1yourkey bun run src/start.ts

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
- Run headful browser for debugging: set `HEADLESS=false` when running `src/start.ts`

Caveats
- Puppeteer downloads Chromium on first install; this can take a few minutes.
- This project uses a modular runtime under `src/start.ts`; harden and monitor for production use (health checks, retries, metrics, storage for logs, etc.).

Troubleshooting
- Repeated `Client disconnected: LOGOUT`:
  - Phone likely invalidated the web session or another device took over. A fresh QR should appear; scan again.
  - If it loops, remove the session folder: `rm -rf .wwebjs_auth` (or set a new `SESSION_DIR`) and restart.
- `Execution context was destroyed` during navigation:
  - Usually harmless; the app now catches and logs it. If persistent, try `HEADLESS=false` to observe the web UI.
  - Consider using system Chrome: set `PUPPETEER_EXECUTABLE_PATH=/path/to/Chrome`.
- Sandbox errors in containerized environments: set `NO_SANDBOX=true`.

Queues
- The modular runtime uses an in-process event bus under `src/queues/`.
- Adapters (WhatsApp, Web, etc.) enqueue normalized inbound events and consume outbound events to send.
- Outbound messages include a `gateway` tag, e.g. `{ npub: GATEWAY_NPUB, type: 'whatsapp'|'web' }`.

Web Gateway UI
- The web gateway runs alongside WhatsApp and serves a minimal chat UI.
- Env:
  - `WEB_PORT` (default: 3010)
  - `WEBID` (optional) — if set, appears by default as an account in the UI
- Start unified runtime:
  GATEWAY_NPUB=<npub> bun run src/start.ts
- Open the UI: `http://localhost:3010`
- Features:
  - Multi-account: add/remove IDs (persisted in localStorage)
  - Send messages from the selected account
  - History auto-loads per account; if mapped to a user npub, history is fetched via npub for the web gateway
  - If an account is not mapped to a user npub, the UI receives an automatic prompt: "Please send me your Beacon ID Connect Code"

Mapping WhatsApp and Web accounts to user npubs
- Use the CLI to create local mappings so conversations thread across gateways under the same `user_npub`.
- Run the wizard:
  bun run src/cli/npub-map.ts
- Create or update two mappings using the same `user_npub`:
  1) Web account
     - Gateway type: `web`
     - Gateway npub: your `GATEWAY_NPUB`
     - Gateway user: the web account ID you use in the UI (or `WEBID` if set)
     - User npub: the canonical npub for this user
  2) WhatsApp account
     - Gateway type: `whatsapp`
     - Gateway npub: your `GATEWAY_NPUB`
     - Gateway user: WhatsApp user id (e.g., `123456789@c.us`)
     - User npub: the same canonical npub as above
- With both mappings set, you can start a conversation on the Web UI and continue on WhatsApp (and vice versa).

Unknown users across gateways
- For any inbound message where the gateway user is not mapped in `local_npub_map`, the gateway does not process the message and sends:
  - "Please setup your Beacon ID first for access to beacon!"
- Implemented for `whatsapp` and `web` adapters; other adapters should use `ensureMappedOrPrompt` from `src/gateway/unknownUser.ts` when adding inbound handling.

Per-user links to remote services (optional)
- The mapping wizard now supports two optional fields to link a user to remote services:
  - Beacon Brain npub (authorizes interactions with the Brain service)
  - Beacon ID npub (authorizes cryptographic signing/spend via ID server)
- Leave these blank to skip; you can update later by re-running the wizard.

Brain + Intent Routing
- Worker: `src/brain/worker.ts` consumes Beacon envelopes and routes intents
- Router: `src/brain/intent_router.ts`
  - If any of the first 5 words include "wingman" → triggers Wingman
  - Otherwise uses OpenRouter via `src/brain/callAI.util.ts` and conversation agent

Wingman Integration
- Trigger: `src/brain/wingman.client.ts` posts to `WINGMAN_API_URL` with a compact JSON prompt
- Webhook: `/api/webhook/wingman_response` accepts { body, beaconID } and replies to the right chat
- Context mapping: `src/brain/beacon_store.ts` remembers inbound routing (to, quotedMessageId, gateway)

Testing (manual)
- WhatsApp login via QR flows and messages appear.
- Web UI reachable at `http://localhost:3010`, supports add/remove accounts, send/receive, and history.
- With mappings set, conversations continue across web and WhatsApp for the same user npub.
