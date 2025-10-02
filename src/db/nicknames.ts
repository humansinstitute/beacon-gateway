import { getDB } from './index';

export interface NickRecord {
  userNpub: string;
  nickname: string;
  lnAddress: string;
  createdAt: number;
}

export function upsertNickname(userNpub: string, nickname: string, lnAddress: string): void {
  const db = getDB();
  const stmt = db.query(`
    INSERT INTO nicknames (user_npub, nickname, ln_address)
    VALUES (?, ?, ?)
    ON CONFLICT(user_npub, nickname) DO UPDATE SET ln_address = excluded.ln_address
  `);
  stmt.run(userNpub.trim(), nickname.trim().toLowerCase(), lnAddress.trim());
}

export function getNickname(userNpub: string, nickname: string): NickRecord | null {
  const db = getDB();
  const row = db.query(`
    SELECT user_npub, nickname, ln_address, created_at
    FROM nicknames WHERE user_npub = ? AND nickname = ?
  `).get(userNpub.trim(), nickname.trim().toLowerCase()) as any;
  if (!row) return null;
  return { userNpub: row.user_npub, nickname: row.nickname, lnAddress: row.ln_address, createdAt: Number(row.created_at) };
}

export function listNicknames(userNpub: string): NickRecord[] {
  const db = getDB();
  const rows = db.query(`
    SELECT user_npub, nickname, ln_address, created_at
    FROM nicknames WHERE user_npub = ? ORDER BY nickname ASC
  `).all(userNpub.trim()) as any[];
  return rows.map(r => ({ userNpub: r.user_npub, nickname: r.nickname, lnAddress: r.ln_address, createdAt: Number(r.created_at) }));
}

export function removeNickname(userNpub: string, nickname: string): boolean {
  const db = getDB();
  const stmt = db.query(`DELETE FROM nicknames WHERE user_npub = ? AND nickname = ?`);
  const res = stmt.run(userNpub.trim(), nickname.trim().toLowerCase()) as any;
  // bun:sqlite returns { changes }
  return Boolean((res?.changes ?? 0) > 0);
}

