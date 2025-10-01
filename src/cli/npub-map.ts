#!/usr/bin/env bun
// Simple interactive wizard to add/update local user npub mappings in SQLite

import { getDB } from '../db';
import { getEnv } from '../types';

async function prompt(question: string, def?: string): Promise<string> {
  const q = def ? `${question} [${def}]: ` : `${question}: `;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const ans: string = await new Promise((res) => rl.question(q, (v) => res(v as string)));
  rl.close();
  return (ans && ans.trim().length > 0) ? ans.trim() : (def || '');
}

async function main() {
  const defaultGateway = await prompt('Gateway type (whatsapp|signal|nostr|mesh|web)', 'whatsapp');
  const defaultNpub = getEnv('GATEWAY_NPUB', '');
  const gatewayNpub = await prompt('Gateway npub (this server npub)', defaultNpub || undefined);
  const gatewayUser = await prompt('Gateway user (e.g., 123456789@c.us)');
  const userNpub = await prompt('User npub (canonical)');
  const beaconBrainNpub = await prompt('Beacon Brain npub (optional)');
  const beaconIdNpub = await prompt('Beacon ID npub (optional)');

  if (!defaultGateway || !gatewayNpub || !gatewayUser || !userNpub) {
    console.error('All fields are required. Aborting.');
    process.exit(1);
  }

  const db = getDB();
  const stmt = db.query(`
    INSERT INTO local_npub_map (
      gateway_type, gateway_npub, gateway_user, user_npub, beacon_brain_npub, beacon_id_npub
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(gateway_type, gateway_npub, gateway_user) DO UPDATE SET
      user_npub = excluded.user_npub,
      beacon_brain_npub = COALESCE(excluded.beacon_brain_npub, local_npub_map.beacon_brain_npub),
      beacon_id_npub = COALESCE(excluded.beacon_id_npub, local_npub_map.beacon_id_npub)
  `);
  stmt.run(
    defaultGateway,
    gatewayNpub,
    gatewayUser,
    userNpub,
    beaconBrainNpub?.trim() ? beaconBrainNpub.trim() : null,
    beaconIdNpub?.trim() ? beaconIdNpub.trim() : null,
  );
  console.log('Mapping saved:', {
    gatewayType: defaultGateway,
    gatewayNpub,
    gatewayUser,
    userNpub,
    beaconBrainNpub: beaconBrainNpub || undefined,
    beaconIdNpub: beaconIdNpub || undefined,
  });
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });
