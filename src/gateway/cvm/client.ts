import { Client as McpClient } from '@modelcontextprotocol/sdk/client';
import { ApplesauceRelayPool, NostrClientTransport, PrivateKeySigner } from '@contextvm/sdk';
import { getEnv } from '../../types';

export interface ReceiveMessageRequest {
  refId: string;
  returnGatewayID: string; // hex pubkey of gateway server
  networkID: string;
  botid?: string;
  botType?: string;
  groupID?: string;
  userId?: string;
  messageID?: string;
  message: string;
}

export interface ReceiveMessageResponse {
  status: 'success' | 'failure';
  description: string;
}

function parseRelays(s: string | undefined | null): string[] {
  const raw = (s || '').trim();
  if (!raw) return ['wss://cvm.otherstuff.ai', 'wss://relay.contextvm.org'];
  return raw.split(',').map((r) => r.trim()).filter(Boolean);
}

export class GatewayCvmClient {
  private mcp?: McpClient;
  private transport?: NostrClientTransport;
  private connected = false;

  constructor(private serverPubkey: string) {}

  async ensure(): Promise<void> {
    if (this.connected) return;
    const priv = (getEnv('BRAIN_CVM_PRIVATE_KEY') || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(priv)) {
      throw new Error('BRAIN_CVM_PRIVATE_KEY must be set (64-char hex)');
    }
    const signer = new PrivateKeySigner(priv);
    const relays = parseRelays(getEnv('CVM_RELAYS'));
    const relayPool = new ApplesauceRelayPool(relays);
    this.transport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey: this.serverPubkey });
    this.mcp = new McpClient({ name: 'beacon-cvm-dispatcher', version: '1.0.0' });
    await this.mcp.connect(this.transport);
    this.connected = true;
    console.log('[cvm-dispatch] connected', { target: this.serverPubkey.slice(0, 8) + '…', relays });
  }

  async receiveMessage(req: ReceiveMessageRequest): Promise<ReceiveMessageResponse> {
    await this.ensure();
    const res = (await this.mcp!.callTool({ name: 'receiveMessage', arguments: req })) as ReceiveMessageResponse;
    return res;
  }

  async close(): Promise<void> {
    await this.mcp?.close();
    this.connected = false;
  }
}

