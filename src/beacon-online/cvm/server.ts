import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplesauceRelayPool, NostrServerTransport, PrivateKeySigner } from '@contextvm/sdk';
import { z } from 'zod';
import { nip19 } from 'nostr-tools';

type Box = 'id' | 'brain';

const RELAYS = ['wss://cvm.otherstuff.ai'];

const ReceiveMessageSchema = {
  gatewayID: z.string(), // npub for the user to route to
  gatewayNpub: z.string(), // this gateway's npub identifier
  type: z.enum(['online_id', 'online_brain']),
  message: z.string(),
  refId: z.string().optional(),
};

function toHexFromMaybeNpub(input: string): string | null {
  const s = (input || '').trim();
  if (!s) return null;
  if (s.startsWith('npub')) {
    try {
      const d = nip19.decode(s);
      if (d.type === 'npub') return String(d.data);
    } catch {
      return null;
    }
  }
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  return null;
}

export async function startBeaconOnlineCvmServer(
  deps: {
    insertInbound: (args: { box: Box; pubkeyHex: string; content: string; refId?: string | null }) => Promise<number>;
    broadcast: (box: Box, pubkeyHex: string, payload: unknown) => Promise<void> | void;
  }
) {
  const priv = (process.env.BEACON_ONLINE_PRIV_GATEWAY_HEX || '').trim();
  if (!priv) {
    console.warn('[beacon-online:cvm] BEACON_ONLINE_PRIV_GATEWAY_HEX not set; CVM server will not start');
    return;
  }

  const signer = new PrivateKeySigner(priv);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();
  const expected = (process.env.BEACON_ONLINE_GATEWAY_HEX || '').trim().toLowerCase();
  console.log('[beacon-online:cvm] starting', { serverPubkey: serverPubkey.slice(0, 8) + '…', relays: RELAYS });
  if (expected && expected !== serverPubkey.toLowerCase()) {
    console.warn('[beacon-online:cvm] WARNING: BEACON_ONLINE_GATEWAY_HEX does not match private key pub', {
      envPub: expected.slice(0,8)+'…',
      derivedPub: serverPubkey.slice(0,8)+'…',
    });
  }

  const mcpServer = new McpServer({ name: 'beacon-online-cvm-server', version: '1.0.0' });

  mcpServer.registerTool(
    'receiveMessage',
    {
      title: 'Receive Web Message',
      description: 'Receives an incoming message for a Beacon Online user and stores it',
      inputSchema: ReceiveMessageSchema,
    },
    async (args) => {
      console.log('[beacon-online:cvm] receiveMessage invoked', {
        gatewayID: String((args as any)?.gatewayID || '').slice(0, 12) + '…',
        gatewayNpub: String((args as any)?.gatewayNpub || '').slice(0, 12) + '…',
        type: String((args as any)?.type || ''),
        hasMessage: !!(args as any)?.message,
        refId: String((args as any)?.refId || ''),
      });
      try {
        const gatewayID = String((args as any).gatewayID || '');
        const type = String((args as any).type || '').toLowerCase();
        const message = String((args as any).message || '');
        const refId = (args as any).refId ? String((args as any).refId) : undefined;
        const pubkeyHex = toHexFromMaybeNpub(gatewayID);
        if (!pubkeyHex) return { status: 'failure', description: 'invalid gatewayID (npub or hex)' };
        const box: Box = type === 'online_brain' ? 'brain' : 'id';

        const id = await deps.insertInbound({ box, pubkeyHex, content: message, refId });
        await deps.broadcast(box, pubkeyHex, { type: 'insert', message: { id, created_at: Math.floor(Date.now()/1000), pubkey: pubkeyHex, box, content: message, status: 'ack' } });
        return { status: 'success', description: `insert refid ${refId || ''}` };
      } catch (err) {
        console.error('[beacon-online:cvm] receiveMessage error', err);
        return { status: 'failure', description: 'unexpected error' };
      }
    }
  );

  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: { name: 'Beacon Online CVM Server' },
  });
  await mcpServer.connect(serverTransport);
  console.log('[beacon-online:cvm] listening');
}
