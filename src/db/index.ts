import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db: Database | null = null;

function ensureDir(filePath: string) {
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
}

export function getDB() {
  if (db) return db;
  const file = process.env.BEACON_SQLITE_PATH || 'data/beacon.sqlite';
  ensureDir(file);
  db = new Database(file, { create: true });
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  // One-time destructive migration controlled via _meta.schema_version
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const getMeta = db.query(`SELECT v FROM _meta WHERE k = 'schema_version'`).get.bind(db.query(`SELECT v FROM _meta WHERE k = 'schema_version'`));
  let current: string | null = null;
  try {
    const row = db.query(`SELECT v FROM _meta WHERE k = 'schema_version'`).get() as any;
    current = row?.v || null;
  } catch {}
  const target = '8';
  const needsReset = current !== target;

  if (needsReset) {
    db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS message_delivery;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS actions;
    DROP TABLE IF EXISTS local_npub_map;
    DROP TABLE IF EXISTS conversation_state;
    DROP TABLE IF EXISTS user_wallets;
    PRAGMA foreign_keys=ON;
    `);

    db.exec(`
    -- Core messages table (every item is a first-class message)
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      reply_to_message_id TEXT NULL REFERENCES messages(id) ON DELETE SET NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      role TEXT NOT NULL CHECK (role IN ('user','beacon','system')),
      user_npub TEXT NULL,
      content_json TEXT NOT NULL,
      attachments_json TEXT NULL,
      metadata_json TEXT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_npub);

    -- Delivery table (only for outbound messages)
    CREATE TABLE IF NOT EXISTS message_delivery (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','canceled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT NULL,
      error_code TEXT NULL,
      error_message TEXT NULL,
      queued_at INTEGER NULL,
      sent_at INTEGER NULL,
      failed_at INTEGER NULL,
      canceled_at INTEGER NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_status ON message_delivery(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_channel_status ON message_delivery(channel, status);
    CREATE INDEX IF NOT EXISTS idx_delivery_updated ON message_delivery(updated_at);

    -- Keep actions table for lightweight audit logging
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beacon_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      type TEXT NOT NULL,
      status TEXT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_beacon_time ON actions(beacon_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);

    -- Local user npub mapping (dev/local)
    CREATE TABLE IF NOT EXISTS local_npub_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_type TEXT NOT NULL,
      gateway_npub TEXT NOT NULL,
      gateway_user TEXT NOT NULL,
      user_npub TEXT NOT NULL,
      beacon_brain_npub TEXT NULL,
      beacon_id_npub TEXT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (gateway_type, gateway_npub, gateway_user)
    );

    -- Conversation consolidated state
    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- User wallets
    CREATE TABLE IF NOT EXISTS user_wallets (
      user_npub TEXT PRIMARY KEY,
      encrypted_nwc_string TEXT NOT NULL,
      ln_address TEXT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    `);

    const upsert = db.query(`INSERT INTO _meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
    upsert.run(target);
  } else {
    // Ensure required tables exist for safety in case of partial state
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        reply_to_message_id TEXT NULL REFERENCES messages(id) ON DELETE SET NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        role TEXT NOT NULL CHECK (role IN ('user','beacon','system')),
        user_npub TEXT NULL,
        content_json TEXT NOT NULL,
        attachments_json TEXT NULL,
        metadata_json TEXT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS message_delivery (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','canceled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        provider_message_id TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        queued_at INTEGER NULL,
        sent_at INTEGER NULL,
        failed_at INTEGER NULL,
        canceled_at INTEGER NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        beacon_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        type TEXT NOT NULL,
        status TEXT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_npub);
      CREATE INDEX IF NOT EXISTS idx_delivery_status ON message_delivery(status);
      CREATE INDEX IF NOT EXISTS idx_delivery_channel_status ON message_delivery(channel, status);
      CREATE INDEX IF NOT EXISTS idx_delivery_updated ON message_delivery(updated_at);
      CREATE INDEX IF NOT EXISTS idx_actions_beacon_time ON actions(beacon_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
      CREATE TABLE IF NOT EXISTS local_npub_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gateway_type TEXT NOT NULL,
        gateway_npub TEXT NOT NULL,
        gateway_user TEXT NOT NULL,
        user_npub TEXT NOT NULL,
        beacon_brain_npub TEXT NULL,
        beacon_id_npub TEXT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE (gateway_type, gateway_npub, gateway_user)
      );
      CREATE TABLE IF NOT EXISTS conversation_state (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // Ensure actions table does not carry stale foreign keys from legacy schema
  try {
    const fkStmt = db.query(`PRAGMA foreign_key_list(actions)`);
    const fks = fkStmt.all() as any[];
    if (fks && fks.length > 0) {
      db.exec(`DROP TABLE IF EXISTS actions;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          beacon_id TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          type TEXT NOT NULL,
          status TEXT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_actions_beacon_time ON actions(beacon_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
      `);
    }
  } catch {}
}

// -------------- Conversation state (summary) --------------
export function getConversationState(conversationId: string): { summary: string; messageCount: number; updatedAt: number } | null {
  const db = getDB();
  const row = db.query(`SELECT summary, message_count, updated_at FROM conversation_state WHERE conversation_id = ?`).get(conversationId) as any;
  if (!row) return null;
  return { summary: row.summary as string, messageCount: Number(row.message_count), updatedAt: Number(row.updated_at) };
}

export function setConversationState(conversationId: string, summary: string, messageCount: number): void {
  const db = getDB();
  const now = nowSeconds();
  const stmt = db.query(`
    INSERT INTO conversation_state (conversation_id, summary, message_count, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, message_count = excluded.message_count, updated_at = excluded.updated_at
  `);
  stmt.run(conversationId, summary, messageCount, now);
}

export function getConversationMessageCount(conversationId: string): number {
  const db = getDB();
  const row = db.query(`SELECT COUNT(1) as c FROM messages WHERE conversation_id = ?`).get(conversationId) as any;
  return Number(row?.c || 0);
}

export function recordInboundMessage(m: import('../types').BeaconMessage): string {
  const db = getDB();
  const id = genId();
  const conversationId = (m.meta?.conversationID || '') as string;
  const userNpub = (m.meta?.userNpub || null) as string | null;
  const content = {
    text: (m.source.text || '').toString(),
    from: m.source.from || null,
    providerMessageId: m.source.messageId || null,
  };
  const metadata = {
    gateway: m.source.gateway,
    source: safeStringified(m.source.messageData),
    meta: m.meta || {},
    hasMedia: !!m.source.hasMedia,
  };
  const stmt = db.query(`
    INSERT INTO messages (
      id, conversation_id, reply_to_message_id, direction, role, user_npub, content_json, attachments_json, metadata_json
    ) VALUES (?, ?, NULL, 'inbound', 'user', ?, ?, NULL, ?)
  `);
  stmt.run(
    id,
    conversationId,
    userNpub,
    JSON.stringify(content),
    JSON.stringify(metadata),
  );
  return id;
}

export function logAction(beaconID: string, type: string, payload: unknown, status?: string) {
  const db = getDB();
  const stmt = db.query(`INSERT INTO actions (beacon_id, type, status, payload_json) VALUES (?, ?, ?, ?)`);
  stmt.run(beaconID, type, status || null, JSON.stringify(payload ?? {}));
}

// Outbound creation (message + delivery queued)
export function createOutboundMessage(params: {
  conversationId: string;
  replyToMessageId?: string | null;
  role?: 'beacon' | 'system';
  userNpub?: string | null;
  content: { text?: string; to?: string; quotedMessageId?: string | null } & Record<string, unknown>;
  metadata?: Record<string, unknown>;
  channel: string; // e.g., 'whatsapp'
}): { messageId: string; deliveryId: string } {
  const db = getDB();
  const messageId = genId();
  const deliveryId = genId();
  const now = nowSeconds();
  const stmtMsg = db.query(`
    INSERT INTO messages (id, conversation_id, reply_to_message_id, direction, role, user_npub, content_json, attachments_json, metadata_json)
    VALUES (?, ?, ?, 'outbound', ?, ?, ?, NULL, ?)
  `);
  stmtMsg.run(
    messageId,
    params.conversationId,
    params.replyToMessageId || null,
    params.role || 'beacon',
    params.userNpub || null,
    JSON.stringify(params.content || {}),
    JSON.stringify(params.metadata || {}),
  );
  const stmtDel = db.query(`
    INSERT INTO message_delivery (id, message_id, channel, status, attempts, queued_at, updated_at)
    VALUES (?, ?, ?, 'queued', 1, ?, ?)
  `);
  stmtDel.run(
    deliveryId,
    messageId,
    params.channel,
    now,
    now,
  );
  return { messageId, deliveryId };
}

export function transitionDelivery(
  deliveryId: string,
  status: 'sent' | 'failed' | 'canceled',
  options?: { providerMessageId?: string; errorCode?: string; errorMessage?: string }
): void {
  const db = getDB();
  const now = nowSeconds();
  let setCols = `status = ?, updated_at = ?`;
  const vals: any[] = [status, now];
  if (status === 'sent') { setCols += `, sent_at = ?`; vals.push(now); }
  if (status === 'failed') { setCols += `, failed_at = ?`; vals.push(now); }
  if (status === 'canceled') { setCols += `, canceled_at = ?`; vals.push(now); }
  if (options?.providerMessageId) { setCols += `, provider_message_id = ?`; vals.push(options.providerMessageId); }
  if (options?.errorCode) { setCols += `, error_code = ?`; vals.push(options.errorCode); }
  if (options?.errorMessage) { setCols += `, error_message = ?`; vals.push(options.errorMessage); }
  const stmt = db.query(`UPDATE message_delivery SET ${setCols} WHERE id = ?`);
  stmt.run(...vals, deliveryId);
}

export function getConversationMessages(conversationId: string, limit = 100, before?: number, after?: number) {
  const db = getDB();
  let where = `conversation_id = ?`;
  const params: any[] = [conversationId];
  if (before) { where += ` AND created_at < ?`; params.push(before); }
  if (after) { where += ` AND created_at > ?`; params.push(after); }
  const sql = `SELECT * FROM messages WHERE ${where} ORDER BY created_at ASC LIMIT ?`;
  params.push(limit);
  const rows = db.query(sql).all(...params) as any[];
  return rows.map(hydrateMessageRow);
}

export function getMessageById(id: string) {
  const db = getDB();
  const row = db.query(`SELECT * FROM messages WHERE id = ?`).get(id) as any;
  return row ? hydrateMessageRow(row) : null;
}

export function getReplies(messageId: string) {
  const db = getDB();
  const rows = db.query(`SELECT * FROM messages WHERE reply_to_message_id = ? ORDER BY created_at ASC`).all(messageId) as any[];
  return rows.map(hydrateMessageRow);
}

export function getDeliveryById(id: string) {
  const db = getDB();
  const row = db.query(`SELECT * FROM message_delivery WHERE id = ?`).get(id) as any;
  return row || null;
}

// -------------------- helpers --------------------
function genId(): string {
  try { return (globalThis as any).crypto?.randomUUID?.() ?? ''; } catch {}
  return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

function safeStringified(s: string): string {
  try { JSON.parse(s); return s; } catch { return JSON.stringify({ raw: s }); }
}

function hydrateMessageRow(row: any) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    replyToMessageId: row.reply_to_message_id,
    direction: row.direction,
    role: row.role,
    content: parseJSON(row.content_json),
    attachments: parseJSON(row.attachments_json),
    metadata: parseJSON(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseJSON(s: string | null) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
