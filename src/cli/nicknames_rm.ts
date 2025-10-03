#!/usr/bin/env bun
// CLI to clear nicknames: all or for a specific npub

import { getDB } from '../db';

async function prompt(question: string, def?: string): Promise<string> {
  const q = def ? `${question} [${def}]: ` : `${question}: `;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((res) => rl.question(q, (v) => res(v as string)));
  rl.close();
  return (ans && ans.trim().length > 0) ? ans.trim() : (def || '');
}

function usage() {
  console.log(`Usage:
  bun run src/cli/nicknames_rm.ts --all        # delete ALL nicknames (with confirmation)
  bun run src/cli/nicknames_rm.ts <userNpub>   # delete nicknames for a specific user npub (with confirmation)
`);
}

async function main() {
  const [arg1] = process.argv.slice(2);
  if (!arg1) { usage(); process.exit(1); }

  const db = getDB();

  if (arg1 === '--all' || arg1 === 'all') {
    const total = (db.query(`SELECT COUNT(1) AS c FROM nicknames`).get() as any)?.c ?? 0;
    if (Number(total) === 0) { console.log('nicknames table is already empty.'); return; }
    console.log(`This will delete ALL ${total} nickname(s).`);
    const conf = (await prompt('Type YES to confirm')).trim();
    if (conf !== 'YES') { console.log('Aborted.'); return; }
    const res = db.query(`DELETE FROM nicknames`).run() as any;
    console.log(`Deleted ${res?.changes ?? 0} row(s).`);
    return;
  }

  // Treat arg1 as npub
  const npub = arg1.trim();
  if (!npub.startsWith('npub')) {
    console.error('Argument does not look like an npub.');
    usage();
    process.exit(1);
  }

  const total = (db.query(`SELECT COUNT(1) AS c FROM nicknames WHERE user_npub = ?`).get(npub) as any)?.c ?? 0;
  if (Number(total) === 0) { console.log(`No nicknames found for ${npub}.`); return; }
  console.log(`This will delete ${total} nickname(s) for ${npub}.`);
  const conf = (await prompt('Type YES to confirm')).trim();
  if (conf !== 'YES') { console.log('Aborted.'); return; }
  const res = db.query(`DELETE FROM nicknames WHERE user_npub = ?`).run(npub) as any;
  console.log(`Deleted ${res?.changes ?? 0} row(s) for ${npub}.`);
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });

