# Repository Guidelines

## Project Structure & Module Organization
- Source code: `src/` — main entrypoints: `src/index.js` (HTTP), `src/start-gateway.ts` (unified runner), `src/whatsapp-gateway-queue.ts` (queue flows).
- Environment: `.env` / `.env.example` at repo root. Session data: `.wwebjs_auth/`; cache: `.wwebjs_cache/`.
- Dependencies: `bun.lock`, `node_modules/`. Docs: `README.md`.
- Tests (if added): `src/__tests__/*.test.ts`.

## Build, Test, and Development Commands
- Install deps: `bun install`
- Run HTTP gateway: `bun run src/index.js`
- Run queue client: `GATEWAY_NPUB=<npub> bun run src/whatsapp-gateway-queue.ts`
- Run unified gateway: `GATEWAY_NPUB=<npub> bun run src/start-gateway.ts`
- Watch (unified): `bun --watch src/start-gateway.ts`
Notes: Bun auto-loads `.env`. Common vars: `PORT`, `SESSION_DIR`, `HEADLESS`, `NO_SANDBOX`, `PUPPETEER_EXECUTABLE_PATH`/`CHROME_BIN`, `GATEWAY_NPUB`.

## Coding Style & Naming Conventions
- Language: Prefer TypeScript for new modules (`.ts`). Keep `src/index.js` Node-compatible JS.
- Indentation: 2 spaces; keep lines concise; remove unused imports.
- Naming: Files like `gateway-*.ts`, `*-queue.ts`. Functions `camelCase`; classes `PascalCase`.
- Logging: Use `console.log/error` with small, structured objects (e.g., `{ event, id, status }`).
- Formatting/Linting: If adding tools, prefer Prettier defaults and ESLint. Do not mass-reformat unrelated code.

## Testing Guidelines
- No formal suite yet. Validate manually:
  - HTTP: `GET /`, `GET /qr`, `POST /send`.
  - Queue stats and graceful shutdown in `src/start-gateway.ts` / `src/whatsapp-gateway-queue.ts`.
- If adding tests: place under `src/__tests__/*.test.ts`; run with `bun test`.

## Commit & Pull Request Guidelines
- Commits: small, atomic, imperative subject (e.g., "Add queue backoff for send failures"). Reference issues (e.g., `#123`).
- PRs must include:
  - Behavior summary and rationale.
  - Steps to run (commands + env vars) and expected outputs.
  - Screenshots/log snippets (QR auth, HTTP responses, queue stats) when relevant.
  - Any `.env` or config changes and migration notes.

## Security & Configuration Tips
- Do not commit secrets, `.env`, or session folders. To reset auth, delete `SESSION_DIR` (default `.wwebjs_auth`) and restart.
- Containers/CI: set `NO_SANDBOX=true` and prefer system Chrome via `PUPPETEER_EXECUTABLE_PATH`.
