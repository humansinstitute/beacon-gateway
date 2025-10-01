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

export type PayLnInvoiceArgs = {
  npub: string;
  refId: string;
  lnInvoice: string;
  responsePubkey: string;
  responseTool: string; // e.g., 'confirmPayment'
};

export type GetLNInvoiceArgs = {
  npub: string;
  refId: string;
  amount: number; // sats
};

export type GetLNAddressArgs = {
  npub: string;
  refId: string;
};

export class CvmClient {
  private mcp?: McpClient;
  private transport?: NostrClientTransport;
  private connected = false;
  private readonly name = 'beacon-brain-cvm-client';

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

    this.mcp = new McpClient({ name: this.name, version: '1.0.0' });

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
    this.ensureUserNpub(args.npub, 'payLnAddress');

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
    this.ensureUserNpub(args.npub, 'getBalance');

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

  async payLnInvoice(args: PayLnInvoiceArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');

    if (!args.npub || !args.refId || !args.lnInvoice || !args.responsePubkey || !args.responseTool) {
      throw new Error('payLnInvoice: missing required fields');
    }
    this.ensureUserNpub(args.npub, 'payLnInvoice');

    console.log('[cvm_client] call payLnInvoice', {
      event: 'call', name: 'payLnInvoice', refId: args.refId, npub: args.npub,
    });

    const res = await this.mcp.callTool({ name: 'payLnInvoice', arguments: args });
    try {
      const preview = safePreview(res);
      console.log('[cvm_client] payLnInvoice result', { refId: args.refId, status: 'ok', preview });
    } catch {
      console.log('[cvm_client] payLnInvoice result (unserializable)', { refId: args.refId, status: 'ok' });
    }
    return res;
  }

  async getLNInvoice(args: GetLNInvoiceArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');

    if (!args.npub || !args.refId || typeof args.amount !== 'number' || !Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error('getLNInvoice: missing or invalid fields');
    }
    this.ensureUserNpub(args.npub, 'getLNInvoice');

    console.log('[cvm_client] call getLNInvoice', {
      event: 'call', name: 'getLNInvoice', refId: args.refId, npub: args.npub, amount: args.amount,
    });

    const res = await this.mcp.callTool({ name: 'getLNInvoice', arguments: args });
    try {
      const preview = safePreview(res);
      console.log('[cvm_client] getLNInvoice result', { refId: args.refId, status: 'ok', preview });
    } catch {
      console.log('[cvm_client] getLNInvoice result (unserializable)', { refId: args.refId, status: 'ok' });
    }
    return res;
  }

  async getLNAddress(args: GetLNAddressArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');

    if (!args.npub || !args.refId) {
      throw new Error('getLNAddress: missing required fields');
    }
    this.ensureUserNpub(args.npub, 'getLNAddress');

    console.log('[cvm_client] call getLNAddress', {
      event: 'call', name: 'getLNAddress', refId: args.refId, npub: args.npub,
    });

    const res = await this.mcp.callTool({ name: 'getLNAddress', arguments: args });
    try {
      const preview = safePreview(res);
      console.log('[cvm_client] getLNAddress result', { refId: args.refId, status: 'ok', preview });
    } catch {
      console.log('[cvm_client] getLNAddress result (unserializable)', { refId: args.refId, status: 'ok' });
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

export async function payLnInvoice(args: PayLnInvoiceArgs) {
  const client = getCvmClient();
  return client.payLnInvoice(args);
}

export async function getLNInvoice(args: GetLNInvoiceArgs) {
  const client = getCvmClient();
  return client.getLNInvoice(args);
}

export async function getLNAddress(args: GetLNAddressArgs) {
  const client = getCvmClient();
  return client.getLNAddress(args);
}

function safePreview(obj: unknown): unknown {
  try {
    const json = JSON.stringify(obj);
    return json.length > 800 ? json.slice(0, 800) + '…' : json;
  } catch {
    return { type: typeof obj };
  }
}

// Ensure we always pass a user npub (npub1...) into tool call arguments
// and never confuse it with hex server pubkeys.
function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

// Narrow validation: must look like an npub and not a hex key.
// Throws with a clear message to avoid accidentally using server keys.
// This is a runtime guard only; we still forward whatever the caller provided.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function looksLikeNpub(npub: string): boolean {
  return typeof npub === 'string' && npub.startsWith('npub') && !isHex64(npub);
}

// Instance method version to include context in error logs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(CvmClient.prototype as any).ensureUserNpub = function(npub: string, tool: string) {
  if (!looksLikeNpub(npub)) {
    throw new Error(`${tool}: expected user npub (npub1...), got invalid value`);
  }
};
