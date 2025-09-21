WhatsApp Web JS Gateway (Bun)

Minimal WhatsApp Web JS gateway using Bun. Provides QR login in terminal and a tiny HTTP API to inspect status and send messages.

Prerequisites
- Bun installed (`bun --version`)
- Chrome/Chromium available for Puppeteer (or Puppeteer will download Chromium on first run)

Setup
1) Install dependencies:
   bun install

2) Run the gateway:
   bun run src/index.js

3) Scan the QR shown in the terminal with the WhatsApp app.

Environment variables (optional)
- `PORT` (default: 3000) — can be set in `.env`
- `SESSION_DIR` (default: .wwebjs_auth)
- `HEADLESS` (default: true) — set to `false` to see the browser UI (useful for debugging)
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
