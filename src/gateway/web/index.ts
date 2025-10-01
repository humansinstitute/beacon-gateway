import { getEnv, toBeaconMessage, GatewayInfo } from '../../types';
import { enqueueBeacon, consumeOut } from '../../queues';
import { resolveUserNpub } from '../npubMap';
import { transitionDelivery } from '../../db';

type Client = {
  id: string;
  socket: WebSocket;
};

const clients: Map<string, Client> = new Map();

function broadcast(event: string, payload: unknown) {
  const msg = JSON.stringify({ event, payload });
  for (const c of clients.values()) {
    try { c.socket.send(msg); } catch {}
  }
}

export function startWebAdapter() {
  const npub = getEnv('GATEWAY_NPUB', '');
  const webId = getEnv('WEBID', '');
  const port = parseInt(getEnv('WEB_PORT', '3010') || '3010', 10);

  const gateway: GatewayInfo = { npub, type: 'web' };

  // Static assets
  const serveStatic = async (path: string) => {
    if (path === '/' || path === '/index.html') {
      return new Response(await Bun.file(import.meta.dir + '/public/index.html').text(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/client.js') {
      return new Response(await Bun.file(import.meta.dir + '/public/client.js').text(), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    }
    if (path === '/styles.css') {
      return new Response(await Bun.file(import.meta.dir + '/public/styles.css').text(), {
        headers: { 'Content-Type': 'text/css; charset=utf-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };

  // Minimal JSON helper
  const json = (data: unknown, code = 200) => new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

  const server = Bun.serve<{ clientId?: string}>({
    port,
    fetch: async (req, server) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === '/health') return json({ ok: true, service: 'web-gateway', npub });

      // WebSocket for realtime events
      if (pathname === '/ws') {
        const clientId = crypto.randomUUID();
        const upgraded = server.upgrade(req, { data: { clientId } });
        if (!upgraded) return new Response('Failed to upgrade', { status: 500 });
        return undefined as unknown as Response; // ws path handled in websocket handler
      }

      // Submit inbound message from web client
      if (pathname === '/api/send' && req.method === 'POST') {
        try {
          const body = await req.json();
          const text = (body.text || '').toString();
          if (!text) return json({ error: 'text is required' }, 400);
          const from = webId;
          if (!from) return json({ error: 'WEBID is not set; configure WEBID in environment to enable sending.' }, 400);

          // Normalize to beacon + enqueue inbound for brain
          const beacon = toBeaconMessage({ source: 'web', text, from }, gateway, {
            from,
            text,
          });
          // Map to canonical user npub if present
          const mapped = resolveUserNpub('web', npub, from);
          if (mapped) beacon.meta.userNpub = mapped;
          enqueueBeacon(beacon);

          // Also announce to connected clients immediately
          broadcast('inbound_ack', { from, text, beaconID: beacon.beaconID });
          return json({ ok: true, beaconID: beacon.beaconID });
        } catch (e: any) {
          return json({ error: 'invalid json', details: String(e?.message || e) }, 400);
        }
      }

      // Static site
      return serveStatic(pathname);
    },
    websocket: {
      open(ws) {
        const clientId = (ws.data as any)?.clientId || crypto.randomUUID();
        clients.set(clientId, { id: clientId, socket: ws });
        // Send hello + defaults
        ws.send(JSON.stringify({ event: 'hello', payload: { clientId, webId } }));
      },
      close(ws) {
        for (const [id, c] of clients) {
          if (c.socket === ws) clients.delete(id);
        }
      },
      message(ws, message) {
        try {
          const data = JSON.parse(typeof message === 'string' ? message : (new TextDecoder().decode(message as ArrayBuffer))) as any;
          if (data?.event === 'send') {
            const text = (data?.payload?.text || '').toString();
            if (!text) return;
            // Proxy to REST handler for consistency
            fetch(`http://localhost:${port}/api/send`, { method: 'POST', body: JSON.stringify({ text }), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
          }
        } catch {}
      },
    },
  });

  // Outbound consumer: deliver messages targeted to web
  consumeOut((msg) => {
    if (msg.gateway.type !== 'web') return;
    // If WEBID is configured, only deliver messages addressed to it
    if (webId && msg.to && msg.to !== webId) return;
    broadcast('outbound', {
      to: webId || null,
      text: msg.body,
      quotedMessageId: msg.quotedMessageId,
      deliveryId: msg.deliveryId,
      messageId: msg.messageId,
    });
    try {
      if (msg.deliveryId) transitionDelivery(msg.deliveryId, 'sent', { providerMessageId: 'web:' + (msg.messageId || '') });
    } catch {}
  });

  console.log(`[web] adapter started; UI http://localhost:${port}`);
  return server;
}
