# Repository Guidelines

## Project Structure & Modules
- Source code: `src/` — main entrypoints are `src/index.js` (HTTP gateway), `src/start-gateway.ts` (unified runner), and `src/whatsapp-gateway-queue.ts` (queue-based flows).
- Environment: `.env` and `.env.example` in repo root; session data stored under `.wwebjs_auth/` and cache in `.wwebjs_cache/`.
- Lockfile: `bun.lock`; dependencies live in `node_modules/`.
- Docs: `README.md` covers setup, API, and troubleshooting.

## Build, Test, and Development
- Install deps: `bun install`
- Run HTTP gateway: `bun run src/index.js`
- Run queue client: `GATEWAY_NPUB=<npub> bun run src/whatsapp-gateway-queue.ts`
- Run unified gateway: `GATEWAY_NPUB=<npub> bun run src/start-gateway.ts`
- Watch mode (unified): `bun --watch src/start-gateway.ts`
Notes
- Bun auto-loads `.env`. Common vars: `PORT`, `SESSION_DIR`, `HEADLESS`, `NO_SANDBOX`, `PUPPETEER_EXECUTABLE_PATH`/`CHROME_BIN`, `GATEWAY_NPUB`.

## Coding Style & Naming
- Language: TypeScript preferred for new modules (`.ts`); keep Node-compatible JS for `src/index.js`.
- Indentation: 2 spaces; keep lines concise; avoid unused imports.
- Naming: use descriptive file names (e.g., `gateway-*.ts`, `*-queue.ts`). Functions: `camelCase`; classes: `PascalCase`.
- Logging: use concise `console.log/error` with structured objects for events.
- Formatting/Linting: if adding tools, prefer Prettier defaults and ESLint (no enforced config yet). Do not introduce project-wide reformatting in unrelated PRs.

## Testing Guidelines
- No formal test suite yet. Validate via:
  - HTTP: `GET /`, `GET /qr`, `POST /send`.
  - Queue stats and graceful shutdown in `src/start-gateway.ts` / `src/whatsapp-gateway-queue.ts`.
- If adding tests, place under `src/__tests__/*.test.ts` and use `bun test`.

## Commit & Pull Requests
- Commits: small, atomic, imperative subject (e.g., "Add queue backoff for send failures"). Reference issues like `#123`.
- PRs must include:
  - Summary of behavior change and rationale.
  - Steps to run (commands + env vars) and expected outputs.
  - Screenshots/log snippets for QR auth, HTTP responses, or queue stats when relevant.
  - Any config changes to `.env` and migration notes.

## Security & Configuration
- Keep secrets out of VCS. Do not commit `.env` or session folders.
- For containers/CI, set `NO_SANDBOX=true` and prefer system Chrome via `PUPPETEER_EXECUTABLE_PATH`.
- To reset auth: delete `SESSION_DIR` (default `.wwebjs_auth`) and restart.
