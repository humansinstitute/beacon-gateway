import { Client as McpClient } from '@modelcontextprotocol/sdk/client';
import { ApplesauceRelayPool, NostrClientTransport, PrivateKeySigner } from '@contextvm/sdk';

const RELAYS = ['wss://cvm.otherstuff.ai'];

export type ReceiveMessageArgs = {
  gatewayID: string; // user's npub on this gateway
  gatewayNpub: string; // local gateway npub (this server)
  type: 'online_id' | 'online_brain';
  message: string;
  refId: string;
};

export async function callRemoteReceiveMessage(params: { toServerHex: string; privateKeyHex: string; args: ReceiveMessageArgs }) {
  const { toServerHex, privateKeyHex, args } = params;
  const hexRe = /^[0-9a-fA-F]{64}$/;
  if (!hexRe.test(toServerHex)) throw new Error('toServerHex must be 64-hex');
  if (!hexRe.test(privateKeyHex)) throw new Error('privateKeyHex must be 64-hex');

  const signer = new PrivateKeySigner(privateKeyHex);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const transport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey: toServerHex });
  const mcp = new McpClient({ name: 'beacon-online-cvm-client', version: '1.0.0' });
  const clientPub = await signer.getPublicKey();
  console.log('[cvm-client] dialing', { server: toServerHex.slice(0,8)+'…', clientPub: clientPub.slice(0,8)+'…', relays: RELAYS });
  const connect = mcp.connect(transport);
  const connectTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('cvm connect timeout')), 15000));
  await Promise.race([connect, connectTimeout]);
  try {
    const tools = await mcp.listTools().catch(() => null as any);
    if (tools && Array.isArray((tools as any).tools)) {
      const names = (tools as any).tools.map((t: any) => t.name);
      console.log('[cvm-client] remote tools', { server: toServerHex.slice(0,8)+'…', names });
      if (!names.includes('receiveMessage')) {
        console.warn('[cvm-client] receiveMessage tool not advertised by remote', { server: toServerHex.slice(0,8)+'…' });
      }
    }
  } catch {}
  try {
    const call = mcp.callTool({ name: 'receiveMessage', arguments: args });
    const timeout = new Promise((_res, rej) => setTimeout(() => rej(new Error('cvm call timeout')), 25000));
    const res = await Promise.race([call, timeout]) as any;
    return res;
  } finally {
    try { await mcp.close(); } catch {}
  }
}
