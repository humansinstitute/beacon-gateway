import { serve } from "bun";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { nip19 } from 'nostr-tools';
import { setTimeout as delay } from "node:timers/promises";

type Box = "id" | "brain";

type MessageRow = {
  id: number;
  created_at: number;
  pubkey: string;
  box: Box;
  content: string;
  signature: string;
  status: string;
  type?: string;
  direction?: string;
  ref_id?: string;
  remote_ref?: string | null;
  metadata?: string | null;
};

// Paths
const DATA_DIR = "src/beacon-online/data";
const PUBLIC_DIR = "src/beacon-online/public";

// Ensure data dir exists
await mkdir(DATA_DIR, { recursive: true });
// No bundling step; frontend loads ESM from CDN directly.

// Two DBs to isolate visibility per requirement
const dbByBox: Record<Box, Database> = {
  id: new Database(`${DATA_DIR}/id.sqlite`, { create: true }),
  brain: new Database(`${DATA_DIR}/brain.sqlite`, { create: true }),
};

for (const box of Object.keys(dbByBox) as Box[]) {
  const db = dbByBox[box];
  db.run(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      pubkey TEXT NOT NULL,
      box TEXT NOT NULL,
      content TEXT NOT NULL,
      signature TEXT NOT NULL,
      event_id TEXT NOT NULL
    )`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_messages_pubkey_box ON messages(pubkey, box, created_at)`
  );
  // Add status column if missing (SQLite lacks IF NOT EXISTS for columns). Best-effort.
  try {
    db.run(`ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'`);
  } catch (_) {
    // ignore if already exists
  }
  for (const col of [
    "type TEXT",
    "direction TEXT",
    "ref_id TEXT",
    "remote_ref TEXT",
    "metadata TEXT",
  ]) {
    try { db.run(`ALTER TABLE messages ADD COLUMN ${col}`); } catch (_) { /* exists */ }
  }
}

// For now, rely on client-side nostr-tools signing. TODO: add server-side verification.

async function handleApi(req: Request) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/api/messages" && req.method === "GET") {
    const boxParam = (url.searchParams.get("box") || "").toLowerCase();
    const pubkey = url.searchParams.get("pubkey") || "";
    if (!pubkey || (boxParam !== "id" && boxParam !== "brain")) {
      return new Response(JSON.stringify({ error: "Missing or invalid params" }), { status: 400 });
    }
    const box = boxParam as Box;
    const db = dbByBox[box];
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));
    const rows = db
      .query(
        `SELECT id, created_at, pubkey, box, content, signature, status, type, direction, ref_id, remote_ref, metadata
         FROM messages WHERE pubkey = ? AND box = ?
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(pubkey, box, limit) as MessageRow[];
    return Response.json({ messages: rows });
  }

  if (pathname === "/api/messages" && req.method === "POST") {
    const payload = await req.json().catch(() => null) as
      | { box: Box; type?: string; refId?: string; event: { id: string; sig: string; pubkey: string; content: string; created_at: number; tags: string[][] } }
      | null;
    if (!payload) return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    const { box, event } = payload;
    if (!box || !event || !event.pubkey || !event.sig || !event.id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }
    if (box !== "id" && box !== "brain") {
      return new Response(JSON.stringify({ error: "Invalid box" }), { status: 400 });
    }
    const ts = event.created_at || Math.floor(Date.now() / 1000);
    const derivedType = box === 'brain' ? 'online_brain' : 'online_id';
    const refId = (payload.refId && typeof payload.refId === 'string' && payload.refId) || crypto.randomUUID();
    const cvmRequest = {
      gatewayNpub: process.env.BEACON_ONLINE_GATEWAY_NPUB || '',
      localGatewayID: event.pubkey,
      gateway_type: derivedType,
      message: event.content,
      refId,
    };
    const db = dbByBox[box];
    const stmt = db.query(
      `INSERT INTO messages(created_at, pubkey, box, content, signature, event_id, status, type, direction, ref_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 'out', ?, ?)`
    );
    const info = stmt.run(ts, event.pubkey, box, event.content, event.sig, event.id, derivedType, refId, JSON.stringify({ cvmRequest }));

    const stored = {
      id: Number(info.lastInsertRowid),
      created_at: ts,
      pubkey: event.pubkey,
      box,
      content: event.content,
      signature: event.sig,
      status: 'draft',
      type: derivedType,
      direction: 'out',
      ref_id: refId,
      remote_ref: null,
      metadata: { cvmRequest },
    } satisfies Omit<MessageRow, 'metadata'> & { metadata: unknown };

    console.log('[beacon-online] outbound draft (minimal)', {
      id: stored.id,
      created_at: stored.created_at,
      pubkey: stored.pubkey,
      box: stored.box,
      status: stored.status,
      type: stored.type,
      cvmRequest,
    });
    // Broadcast SSE update
    broadcast(box, event.pubkey, { type: 'insert', message: stored });
    // Fire-and-forget: try to call remote CVM receiveMessage
    ;(async () => {
      const toServerHex = box === 'brain' ? (process.env.BRAIN_CVM_HEX || '') : (process.env.ID_CVM_HEX || '');
      const priv = (process.env.BEACON_ONLINE_PRIV_GATEWAY_HEX || '').trim();
      if (!toServerHex || !priv) {
        console.warn('[beacon-online] CVM send skipped: missing toServerHex or BEACON_ONLINE_PRIV_GATEWAY_HEX');
        return;
      }
      try {
        const { callRemoteReceiveMessage } = await import('./cvm/client');
        const userNpub = (() => { try { return nip19.npubEncode(stored.pubkey); } catch { return ''; } })();
        const args = {
          gatewayID: userNpub || stored.pubkey,
          gatewayNpub: process.env.BEACON_ONLINE_GATEWAY_NPUB || '',
          type: derivedType as 'online_id' | 'online_brain',
          message: stored.content,
          refId,
        };
        console.log('[beacon-online] CVM send (attempt)', args);
        const res = await callRemoteReceiveMessage({
          toServerHex,
          privateKeyHex: priv,
          args,
        });
        const preview = (() => { try { const j = JSON.stringify(res); return j.length > 500 ? j.slice(0,500)+'…' : j; } catch { return String(res); } })();
        const ok = true;
        // Update status to 'sent' (optimistic); if remote replies success explicitly we can mark 'ack'
        const upd = db.prepare(`UPDATE messages SET status = 'sent' WHERE id = ?`);
        upd.run(stored.id);
        await broadcast(box, stored.pubkey, { type: 'update', message: { id: stored.id, status: 'sent' } });
        console.log('[beacon-online] CVM send result', { refId, box, toServerHex: toServerHex.slice(0,8)+'…', ok, preview });
      } catch (err) {
        console.error('[beacon-online] CVM send failed', err);
        try {
          const upd = db.prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`);
          upd.run(stored.id);
          await broadcast(box, stored.pubkey, { type: 'update', message: { id: stored.id, status: 'failed' } });
        } catch {}
      }
    })();

    return Response.json({
      id: stored.id,
      created_at: stored.created_at,
      pubkey: stored.pubkey,
      box: stored.box,
      content: stored.content,
      status: stored.status,
      type: stored.type,
      ref_id: stored.ref_id,
      cvmRequest,
    });
  }

  return new Response("Not found", { status: 404 });
}

// --- SSE support ---
type Client = { write: (s: string) => Promise<void>; close: () => void };
const clients: Map<string, Set<Client>> = new Map(); // key = `${box}|${pubkey}`

function keyFor(box: Box, pubkey: string) { return `${box}|${pubkey}`; }

async function broadcast(box: Box, pubkey: string, payload: unknown) {
  const key = keyFor(box, pubkey);
  const group = clients.get(key);
  if (!group || group.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...group]) {
    try { await c.write(data); } catch { try { c.close(); } catch {} group.delete(c); }
  }
}

async function handleSse(req: Request) {
  const url = new URL(req.url);
  const boxParam = (url.searchParams.get('box') || '').toLowerCase();
  const pubkey = url.searchParams.get('pubkey') || '';
  if (!pubkey || (boxParam !== 'id' && boxParam !== 'brain')) {
    return new Response('Bad params', { status: 400 });
  }
  const box = boxParam as Box;
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const write = async (s: string) => { await writer.write(encoder.encode(s)); };
  const flushHello = async () => {
    await write(`event: hello\n`);
    await write(`data: ok\n\n`);
    await write(`retry: 3000\n\n`);
  };
  const client: Client = {
    write,
    close: () => { try { writer.close(); } catch { /* ignore */ } },
  };
  const key = keyFor(box, pubkey);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key)!.add(client);

  // Heartbeat pings
  (async () => {
    try {
      while (true) {
        await delay(15000);
        await write(`: ping ${Date.now()}\n\n`);
      }
    } catch {
      // writer closed
    }
  })();

  // Remove on close/abort
  const onClose = () => {
    const set = clients.get(key);
    if (set) set.delete(client);
    try { writer.close(); } catch {}
  };
  (req.signal as AbortSignal).addEventListener('abort', onClose);

  // Kick off initial send
  flushHello();

  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  } as Record<string, string>;
  const res = new Response(stream.readable, { headers });
  // Bun doesn't expose onclose/onerror here; rely on abort signal cleanup and write failures.
  return res;
}

const port = Number(process.env.REMOTE_PORT || process.env.PORT || 8788);
const server = serve({
  port,
  // Keep connections (SSE) alive; 0 = disable timeout in Bun
  idleTimeout: 0,
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        return handleSse(req);
      }
      return handleApi(req);
    }
    // Static
    let path = url.pathname;
    if (path === "/") path = "/index.html";
    if (path === "/favicon.ico") path = "/favicon.svg"; // map ico to svg
    // On-demand build of frontend bundle (ensures local, offline nostr-tools)
    if (path === "/main.js") {
      await Bun.build({
        entrypoints: ["src/beacon-online/web/main.ts"],
        outdir: "src/beacon-online/public",
        target: "browser",
        naming: "[name].js",
      });
    }
    const filePath = `${PUBLIC_DIR}${path}`;
    const file = Bun.file(filePath);
    if (!file.size) {
      return new Response("Not found", { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const ext = filePath.split('.').pop() || '';
    const type =
      ext === 'html' ? 'text/html; charset=utf-8' :
      ext === 'js' ? 'application/javascript; charset=utf-8' :
      ext === 'svg' ? 'image/svg+xml' :
      ext === 'css' ? 'text/css; charset=utf-8' :
      'application/octet-stream';
    return new Response(file, { headers: { 'content-type': type } });
  },
});

console.log(`[beacon-online] server listening on :${server.port} (env REMOTE_PORT=${process.env.REMOTE_PORT || ''})`);

// Start CVM server (receiveMessage tool) alongside HTTP server
import { startBeaconOnlineCvmServer } from './cvm/server';
(async () => {
  try {
    await startBeaconOnlineCvmServer({
      insertInbound: async ({ box, pubkeyHex, content, refId }) => {
        const ts = Math.floor(Date.now() / 1000);
        const db = dbByBox[box];
        const stmt = db.query(
          `INSERT INTO messages(created_at, pubkey, box, content, signature, event_id, status, type, direction, ref_id, metadata)
           VALUES (?, ?, ?, ?, ?, ?, 'ack', ?, 'in', ?, ?)`
        );
        const info = stmt.run(ts, pubkeyHex, box, content, '', `remote:${refId || ''}`, box === 'brain' ? 'online_brain' : 'online_id', refId || null, JSON.stringify({ source: 'cvm_receiveMessage' }));
        return Number(info.lastInsertRowid);
      },
      broadcast: (box, pubkeyHex, payload) => broadcast(box, pubkeyHex, payload),
    });
  } catch (err) {
    console.error('[beacon-online] failed to start CVM server', err);
  }
})();
