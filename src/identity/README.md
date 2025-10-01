Identity Service — Local Testing Guide

- Purpose: run the Identity service alongside the Brain on the same machine, choose gateways (Web/WhatsApp), and test payment approvals.

Environment variables
- `PORT`: Identity health HTTP (default `3010`). Example: `3011`.
- `WEB_PORT`: Web gateway UI/API port (default `3010`). Example: `3012`.
- `BEACON_ID_WHATSAPP`: Enable WhatsApp adapter for Identity (`true|false`). Default: `true`.
- `BEACON_ID_WEB`: Enable Web adapter for Identity (`true|false`). Default: `false`.
- `BEACON_AUTO`: Optional auto-approve timeout in seconds. If set (e.g., `15`), auto-approves pending requests after that many seconds if no user reply.
- `GATEWAY_NPUB`: npub for this Identity gateway instance (used for filtering and DB mapping lookups).
- `SESSION_DIR`: WhatsApp auth directory. Use a distinct path if you also run Brain’s WhatsApp.

Recommended local setup (Web only)
- Terminal 1 (Brain):
  - `PORT=3010 SESSION_DIR=.wwebjs_auth bun run src/start.ts`
- Terminal 2 (Identity):
  - `PORT=3011 WEB_PORT=3012 BEACON_ID_WEB=true BEACON_ID_WHATSAPP=false BEACON_AUTO=15 bun run src/identity_start.ts`
- Open the Web UI: `http://localhost:3012`

WhatsApp-only variant
- `PORT=3011 BEACON_ID_WEB=false BEACON_ID_WHATSAPP=true SESSION_DIR=.wwebjs_auth_identity bun run src/identity_start.ts`

Port tips
- Avoid conflicts with other services (Brain often uses `3010`).
- If you change `PORT`, also ensure `WEB_PORT` doesn’t collide with either `PORT` or the Brain’s port.

User mapping (required for routing and history)
- Map a user to the Web or WhatsApp gateway so approvals go to the right destination and show up in history.
- CLI helper:
  - `bun run src/cli/npub-map.ts`
  - Gateway type: `web` (or `whatsapp`)
  - Gateway npub: your Identity `GATEWAY_NPUB`
  - Gateway user: Web account id (use `WEBID` or the account you select in the Web UI), or WhatsApp JID
  - User npub: canonical npub of the user

Approval flow
- Identity prefers Web for prompts when a Web mapping exists; otherwise falls back to WhatsApp.
- With `BEACON_AUTO` set, pending approvals auto-complete after N seconds if no user reply.

Troubleshooting
- No prompt in Web after refresh: ensure mapping exists for `gateway_type='web'`, `gateway_npub=<Identity npub>`, and the active account matches the mapped `gateway_user`.
- No DB entries: verify `BEACON_SQLITE_PATH` points to the same file you are inspecting (default `data/beacon.sqlite`).
- Port in use: change `PORT` or `WEB_PORT` to a free port.

