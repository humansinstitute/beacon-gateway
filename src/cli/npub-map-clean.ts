#!/usr/bin/env bun
// Simple CLI to search and optionally delete rows from local_npub_map

import { getDB } from '../db';

async function prompt(question: string, def?: string): Promise<string> {
  const q = def ? `${question} [${def}]: ` : `${question}: `;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((res) => rl.question(q, (v) => res(v as string)));
  rl.close();
  return (ans && ans.trim().length > 0) ? ans.trim() : (def || '');
}

function normalizeWhatsAppId(input: string): string {
  let s = input.trim();
  if (s.includes('@')) {
    const [user, domain] = s.split('@');
    s = (user || '').replace(/\D+/g, '');
  } else {
    s = s.replace(/\D+/g, '');
  }
  if (!s) return '';
  return `${s}@c.us`;
}

async function main() {
  const db = getDB();

  const gatewayType = (await prompt('Gateway type (whatsapp|signal|nostr|mesh|web)', 'whatsapp')).toLowerCase();
  if (!gatewayType) {
    console.error('Gateway type is required.');
    process.exit(1);
  }
  const gatewayNpub = await prompt('Gateway npub filter (optional; leave blank for any)');

  // Fetch distinct gateway_user for this type (and optional npub), show as a numbered list
  let users: any[];
  if (gatewayNpub && gatewayNpub.trim()) {
    users = db
      .query(
        `SELECT gateway_user, COUNT(*) as cnt, MAX(created_at) as last
         FROM local_npub_map
         WHERE gateway_type = ? AND gateway_npub = ?
         GROUP BY gateway_user
         ORDER BY last DESC`
      )
      .all(gatewayType, gatewayNpub.trim()) as any[];
  } else {
    users = db
      .query(
        `SELECT gateway_user, COUNT(*) as cnt, MAX(created_at) as last
         FROM local_npub_map
         WHERE gateway_type = ?
         GROUP BY gateway_user
         ORDER BY last DESC`
      )
      .all(gatewayType) as any[];
  }

  if (!users || users.length === 0) {
    console.log('No users found for this gateway type.');
    process.exit(0);
  }

  console.log(`Found ${users.length} user identifier(s):`);
  users.forEach((r, i) => {
    console.log(`${i + 1}. ${r.gateway_user} (${r.cnt} row${Number(r.cnt) === 1 ? '' : 's'})`);
  });

  const selection = (await prompt('Select number(s) to delete (comma-separated) or leave blank to abort')).trim();
  if (!selection) {
    console.log('Aborted; no deletions performed.');
    process.exit(0);
  }
  const idxs = selection
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= users.length);
  if (idxs.length === 0) {
    console.log('No valid selections. Aborting.');
    process.exit(0);
  }

  const selectedUsers = [...new Set(idxs.map((i) => users[i - 1].gateway_user))];
  console.log('You are about to delete mappings for:', selectedUsers);
  const confirm = (await prompt('Type YES to confirm')).trim();
  if (confirm !== 'YES') {
    console.log('Deletion canceled.');
    process.exit(0);
  }

  if (gatewayNpub && gatewayNpub.trim()) {
    const placeholdersUsers = selectedUsers.map(() => '?').join(',');
    const stmt = db.query(
      `DELETE FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user IN (${placeholdersUsers})`
    );
    stmt.run(gatewayType, gatewayNpub.trim(), ...selectedUsers);
  } else {
    const placeholdersUsers = selectedUsers.map(() => '?').join(',');
    const stmt = db.query(
      `DELETE FROM local_npub_map WHERE gateway_type = ? AND gateway_user IN (${placeholdersUsers})`
    );
    stmt.run(gatewayType, ...selectedUsers);
  }
  console.log('Deleted users:', selectedUsers);
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });
