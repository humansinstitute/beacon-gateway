import { Client as McpClient } from '@modelcontextprotocol/sdk/client';
import { ApplesauceRelayPool, NostrClientTransport, PrivateKeySigner } from '@contextvm/sdk';
import { getEnv } from '../../types';

// Default relays for Context VM
const RELAYS = ['wss://relay.contextvm.org', 'wss://cvm.otherstuff.ai'];
const DEBUG = (getEnv('CVM_DEBUG', '').toLowerCase() === 'true');

export type PayLnAddressArgs = {
  npub: string;
  refId: string;
  lnAddress: string;
  amount: number; // sats
  responsePubkey: string;
  responseTool: string; // e.g., 'confirmPayment'
};

export type GetBalanceArgs = {
  npub: string;
  refId: string;
};

export class CvmClient {
  private mcp?: McpClient;
  private transport?: NostrClientTransport;
  private connected = false;

  constructor(
    private readonly serverPubkey = getEnv('BEACON_ID_CVM_PUB', '').trim(),
    private readonly privateKey = getEnv('BRAIN_CVM_PRIVATE_KEY', '').trim(),
    private readonly relays: string[] = RELAYS,
  ) {}

  async connect(): Promise<void> {
    if (this.connected && this.mcp) return;

    if (!this.serverPubkey) throw new Error('BEACON_ID_CVM_PUB is not set in env');
    // Validate server pubkey: must be 32-byte hex (x-only Schnorr pubkey)
    const hexRe = /^[0-9a-fA-F]{64}$/;
    if (!hexRe.test(this.serverPubkey)) {
      if (this.serverPubkey.startsWith('npub')) {
        throw new Error('BEACON_ID_CVM_PUB must be 64-char hex (not npub). Provide hex pubkey.');
      }
      throw new Error('BEACON_ID_CVM_PUB must be 32-byte hex (64 chars)');
    }
    if (!this.privateKey || this.privateKey.startsWith('YOUR_'))
      throw new Error('BRAIN_CVM_PRIVATE_KEY is missing or placeholder');
    if (!hexRe.test(this.privateKey)) {
      throw new Error('BRAIN_CVM_PRIVATE_KEY must be 32-byte hex (64 chars)');
    }

    const signer = new PrivateKeySigner(this.privateKey);
    const relayPool = new ApplesauceRelayPool(this.relays);

    this.transport = new NostrClientTransport({
      signer,
      relayHandler: relayPool,
      serverPubkey: this.serverPubkey,
    });

    this.mcp = new McpClient({ name: 'beacon-brain-cvm-client', version: '1.0.0' });

    await this.mcp.connect(this.transport);
    this.connected = true;

    // Connection established; avoid listing tools to prevent failures in some environments
    console.log('[cvm_client] connected', {
      event: 'connect',
      relays: this.relays,
      serverPubkey: this.serverPubkey.slice(0, 8) + '…',
    });
  }

  async payLnAddress(args: PayLnAddressArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');

    // Minimal validation
    if (!args.npub || !args.refId || !args.lnAddress || !args.amount || !args.responsePubkey || !args.responseTool) {
      throw new Error('payLnAddress: missing required fields');
    }

    console.log('[cvm_client] call payLnAddress', {
      event: 'call', name: 'payLnAddress', refId: args.refId, npub: args.npub, amount: args.amount,
      lnAddress: args.lnAddress,
    });

    const res = await this.mcp.callTool({ name: 'payLnAddress', arguments: args });
    try {
      const preview = safePreview(res);
      console.log('[cvm_client] payLnAddress result', { refId: args.refId, status: 'ok', preview });
    } catch {
      console.log('[cvm_client] payLnAddress result (unserializable)', { refId: args.refId, status: 'ok' });
    }
    return res;
  }

  async getBalance(args: GetBalanceArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');

    if (!args.npub || !args.refId) {
      throw new Error('getBalance: missing required fields');
    }

    console.log('[cvm_client] call getBalance', {
      event: 'call', name: 'getBalance', refId: args.refId, npub: args.npub,
    });

    const res = await this.mcp.callTool({ name: 'getBalance', arguments: args });
    try {
      const preview = safePreview(res);
      console.log('[cvm_client] getBalance result', { refId: args.refId, status: 'ok', preview });
    } catch {
      console.log('[cvm_client] getBalance result (unserializable)', { refId: args.refId, status: 'ok' });
    }
    return res;
  }

  async close(): Promise<void> {
    try {
      await this.mcp?.close();
    } finally {
      this.connected = false;
      this.transport = undefined;
      this.mcp = undefined;
    }
  }
}

// Simple singleton for convenience
let singleton: CvmClient | undefined;
export function getCvmClient(): CvmClient {
  if (!singleton) singleton = new CvmClient();
  return singleton;
}

export async function payLnAddress(args: PayLnAddressArgs) {
  const client = getCvmClient();
  return client.payLnAddress(args);
}

export async function getBalance(args: GetBalanceArgs) {
  const client = getCvmClient();
  return client.getBalance(args);
}

function safePreview(obj: unknown): unknown {
  try {
    const json = JSON.stringify(obj);
    return json.length > 800 ? json.slice(0, 800) + '…' : json;
  } catch {
    return { type: typeof obj };
  }
}
