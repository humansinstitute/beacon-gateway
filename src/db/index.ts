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
  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    beacon_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    responded_at INTEGER NULL,
    gateway_type TEXT,
    gateway_npub TEXT,
    from_jid TEXT,
    provider_message_id TEXT,
    message_text TEXT NOT NULL,
    response_text TEXT NULL,
    response_type TEXT NULL,
    response_error TEXT NULL,
    has_media INTEGER,
    media_meta_json TEXT NULL,
    source_json TEXT NOT NULL,
    meta_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_jid);
  CREATE INDEX IF NOT EXISTS idx_messages_gateway ON messages(gateway_npub);

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beacon_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    type TEXT NOT NULL,
    status TEXT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (beacon_id) REFERENCES messages(beacon_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_actions_beacon_time ON actions(beacon_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
  `);
}

export function recordInboundMessage(m: import('../types').BeaconMessage) {
  const db = getDB();
  const sourceJson = JSON.stringify(m.source);
  const metaJson = JSON.stringify(m.meta || {});
  const stmt = db.query(`
    INSERT OR IGNORE INTO messages (
      beacon_id, conversation_id, gateway_type, gateway_npub, from_jid, provider_message_id,
      message_text, has_media, source_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    m.beaconID,
    m.meta?.conversationID || null,
    m.source.gateway.type,
    m.source.gateway.npub,
    m.source.from || null,
    m.source.messageId || null,
    (m.source.text || '').toString(),
    m.source.hasMedia ? 1 : 0,
    sourceJson,
    metaJson,
  );
}

export function logAction(beaconID: string, type: string, payload: unknown, status?: string) {
  const db = getDB();
  const stmt = db.query(`INSERT INTO actions (beacon_id, type, status, payload_json) VALUES (?, ?, ?, ?)`);
  stmt.run(beaconID, type, status || null, JSON.stringify(payload ?? {}));
}

export function setMessageResponse(
  beaconID: string,
  responseText: string | null,
  responseType: string | null,
  error?: string | null,
) {
  const db = getDB();
  if (responseText != null && responseType) {
    const stmt = db.query(`
      UPDATE messages SET response_text = ?, response_type = ?, responded_at = strftime('%s','now'), response_error = NULL
      WHERE beacon_id = ?
    `);
    stmt.run(responseText, responseType, beaconID);
  } else if (error) {
    const stmt = db.query(`UPDATE messages SET response_error = ? WHERE beacon_id = ?`);
    stmt.run(error, beaconID);
  }
}

