#!/usr/bin/env bun
// CLI for managing per-user nicknames -> LN address mappings

import { upsertNickname, listNicknames, removeNickname } from '../db/nicknames';

function usage() {
  console.log(`Usage:
  bun run src/cli/nicknames.ts add <userNpub> <nickname> <lnAddress>
  bun run src/cli/nicknames.ts list <userNpub>
  bun run src/cli/nicknames.ts remove <userNpub> <nickname>
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { usage(); process.exit(1); }

  if (cmd === 'add') {
    const [userNpub, nickname, lnAddress] = args;
    if (!userNpub || !nickname || !lnAddress) { usage(); process.exit(1); }
    upsertNickname(userNpub, nickname, lnAddress);
    console.log('Saved nickname:', { userNpub, nickname: nickname.toLowerCase(), lnAddress });
    return;
  }

  if (cmd === 'list') {
    const [userNpub] = args;
    if (!userNpub) { usage(); process.exit(1); }
    const rows = listNicknames(userNpub);
    if (rows.length === 0) {
      console.log('No nicknames found for', userNpub);
      return;
    }
    for (const r of rows) {
      console.log(`- ${r.nickname} -> ${r.lnAddress}`);
    }
    return;
  }

  if (cmd === 'remove') {
    const [userNpub, nickname] = args;
    if (!userNpub || !nickname) { usage(); process.exit(1); }
    const ok = removeNickname(userNpub, nickname);
    console.log(ok ? 'Removed.' : 'No matching record.');
    return;
  }

  usage();
  process.exit(1);
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });

