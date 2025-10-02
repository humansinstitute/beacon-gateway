**Beacon Online CVM Client Spec**

- Goal: Add a tiny, callable client that triggers the Beacon Online CVM server tool `receiveMessage`, mirroring patterns used in `src/brain/cvm_client/cvm_client.ts`. 
This s

**Environment**
- `BEACON_ONLINE_GATEWAY_HEX`: 64-hex target server pubkey (derived from server’s private key). Required.
- `BEACON_ONLINE_CVM_PRIVATE_KEY`: 64-hex client private key used to sign the Nostr MCP session. Required.
- Relays: `wss://cvm.otherstuff.ai` (same as existing server/client defaults).

**Tool Target**
- Remote tool name: `receiveMessage` (defined in `src/beacon-online/cvm/server.ts`).
- Behavior: Validates `gatewayID`, inserts inbound, broadcasts ack. Returns `{ status, description }`.

**API Shape**
- Export one function for reuse elsewhere:
  - `sendBeaconOnlineMessage(args: { gatewayID: string; gatewayNpub: string; type: 'online_id' | 'online_brain'; message: string; refId?: string; })` → calls remote `receiveMessage`.
- Internal client class mirrors `CvmClient` from `src/brain/cvm_client/cvm_client.ts`:
  - Creates `PrivateKeySigner`, `ApplesauceRelayPool`, `NostrClientTransport`.
  - Uses an `McpClient` with `connect()` on first call; keeps a simple singleton.
  - Logs concise structured objects on connect and call.

**Validation & Logging**
- Validate envs: both must be 64-hex; error if missing or placeholder.
- Validate required fields in `args` (gatewayID, gatewayNpub, type, message).
- Log on connect: `{ relays, serverPubkey }`.
- Log on call: `{ type, gatewayID (prefix), gatewayNpub (prefix), hasMessage, refId }`.
- Log result with safe preview (truncate JSON >800 chars) like `safePreview` in `src/brain/cvm_client/cvm_client.ts`.

**Implementation Sketch (cvmclient.ts)**
- Create file: `src/beacon_online/examples/cvmclient.ts`.
- Structure:
  - Read envs using `getEnv` from `src/types.ts`.
  - Define `BeaconOnlineReceiveArgs` type.
  - Class `BeaconOnlineCvmClient` with `connect()`, `receiveMessage()`, `close()`.
  - Singleton accessor and exported function `sendBeaconOnlineMessage()`.
  - Helper `safePreview()` copied from `src/brain/cvm_client/cvm_client.ts` (same truncation behavior).

Example code outline:

```ts
import { Client as McpClient } from '@modelcontextprotocol/sdk/client';
import { ApplesauceRelayPool, NostrClientTransport, PrivateKeySigner } from '@contextvm/sdk';
import { getEnv } from '../../types';

const RELAYS = ['wss://cvm.otherstuff.ai'];
const SERVER_PUB_HEX = getEnv('BEACON_ONLINE_GATEWAY_HEX', '').trim();
const CLIENT_PRIV_HEX = getEnv('BEACON_ONLINE_CVM_PRIVATE_KEY', '').trim();

export type BeaconOnlineReceiveArgs = {
  gatewayID: string;
  gatewayNpub: string;
  type: 'online_id' | 'online_brain';
  message: string;
  refId?: string;
};

class BeaconOnlineCvmClient {
  private mcp?: McpClient;
  private transport?: NostrClientTransport;
  private connected = false;

  constructor(
    private readonly serverPubkey = SERVER_PUB_HEX,
    private readonly privateKey = CLIENT_PRIV_HEX,
    private readonly relays: string[] = RELAYS,
  ) {}

  private isHex64(s: string) { return /^[0-9a-fA-F]{64}$/.test(s); }

  async connect() {
    if (this.connected && this.mcp) return;
    if (!this.serverPubkey || !this.isHex64(this.serverPubkey)) throw new Error('BEACON_ONLINE_GATEWAY_HEX must be 64-hex');
    if (!this.privateKey || !this.isHex64(this.privateKey)) throw new Error('BEACON_ONLINE_CVM_PRIVATE_KEY must be 64-hex');
    const signer = new PrivateKeySigner(this.privateKey);
    const relayPool = new ApplesauceRelayPool(this.relays);
    this.transport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey: this.serverPubkey });
    this.mcp = new McpClient({ name: 'beacon-online-cvm-example', version: '1.0.0' });
    await this.mcp.connect(this.transport);
    this.connected = true;
    console.log('[beacon_online:cvmclient] connected', { relays: this.relays, serverPubkey: this.serverPubkey.slice(0,8)+'…' });
  }

  async receiveMessage(args: BeaconOnlineReceiveArgs) {
    await this.connect();
    if (!this.mcp) throw new Error('MCP client not initialized');
    if (!args.gatewayID || !args.gatewayNpub || !args.type || typeof args.message !== 'string') throw new Error('receiveMessage: missing required fields');
    console.log('[beacon_online:cvmclient] call receiveMessage', {
      type: args.type,
      gatewayID: String(args.gatewayID).slice(0,12)+'…',
      gatewayNpub: String(args.gatewayNpub).slice(0,12)+'…',
      hasMessage: !!args.message,
      refId: args.refId || '',
    });
    const res = await this.mcp.callTool({ name: 'receiveMessage', arguments: args });
    try { console.log('[beacon_online:cvmclient] receiveMessage result', { status: 'ok', preview: safePreview(res) }); }
    catch { console.log('[beacon_online:cvmclient] receiveMessage result (unserializable)'); }
    return res;
  }

  async close() { try { await this.mcp?.close(); } finally { this.connected = false; this.transport = undefined; this.mcp = undefined; } }
}

let singleton: BeaconOnlineCvmClient | undefined;
function getClient() { return (singleton ??= new BeaconOnlineCvmClient()); }
export async function sendBeaconOnlineMessage(args: BeaconOnlineReceiveArgs) { return getClient().receiveMessage(args); }

function safePreview(obj: unknown): unknown {
  try { const json = JSON.stringify(obj); return json.length > 800 ? json.slice(0,800)+'…' : json; }
  catch { return { type: typeof obj }; }
}
```

**Usage (from elsewhere)**
- Read envs (Bun auto-loads `.env`). Then call:

```ts
import { sendBeaconOnlineMessage } from 'src/beacon_online/examples/cvmclient.ts';

await sendBeaconOnlineMessage({
  gatewayID: 'npub1exampleuser…',
  gatewayNpub: 'npub1yourgateway…',
  type: 'online_brain',
  message: 'hello from example client',
  refId: 'test-123',
});
```

**Notes**
- If the server isn’t running with a private key, it won’t start listening; ensure the server side has `BEACON_ONLINE_PRIV_GATEWAY_HEX` and the derived pub matches `BEACON_ONLINE_GATEWAY_HEX` if you set both.
- Timeouts are handled implicitly by MCP transport; add explicit timeouts in callers if needed.
- Keep logs concise and structured as in the example above.

