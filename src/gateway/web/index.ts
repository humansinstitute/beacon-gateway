import { getEnv, toBeaconMessage, GatewayInfo } from '../../types';
import { enqueueBeacon, consumeOut } from '../../queues';
import { resolveUserNpub } from '../npubMap';
import { ensureMappedOrPrompt, UNKNOWN_USER_PROMPT } from '../unknownUser';
import { transitionDelivery, getDB, createOutboundMessage, logAction } from '../../db';

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
          const from = (body.from || webId || '').toString();
          if (!text) return json({ error: 'text is required' }, 400);
          if (!from) return json({ error: 'from is required (supply an account id)' }, 400);

          // Normalize to beacon
          const beacon = toBeaconMessage({ source: 'web', text, from }, gateway, {
            from,
            text,
          });
          // Map to canonical user npub if present. If missing, send prompt via web channel and stop.
          const mapped = await ensureMappedOrPrompt('web', npub, from, (promptText) => {
            try {
              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: beacon.meta?.conversationID || '',
                replyToMessageId: undefined,
                role: 'beacon',
                userNpub: null,
                content: { text: promptText || UNKNOWN_USER_PROMPT, to: from },
                metadata: { gateway: gateway },
                channel: gateway.type,
              });
              broadcast('outbound', { to: from, text: promptText || UNKNOWN_USER_PROMPT, messageId, deliveryId });
              transitionDelivery(deliveryId, 'sent', { providerMessageId: 'web:' + messageId });
              logAction(beacon.beaconID, 'web_prompt_connect_code', { to: from }, 'ok');
            } catch {}
          });
          if (!mapped) {
            broadcast('inbound_ack', { from, text, beaconID: beacon.beaconID });
            return json({ ok: true, beaconID: beacon.beaconID, mapped: false });
          }

          // Known user: set mapping and enqueue for processing
          beacon.meta.userNpub = mapped;
          enqueueBeacon(beacon);

          // Also announce to connected clients immediately
          broadcast('inbound_ack', { from, text, beaconID: beacon.beaconID });
          return json({ ok: true, beaconID: beacon.beaconID, mapped: true });
        } catch (e: any) {
          return json({ error: 'invalid json', details: String(e?.message || e) }, 400);
        }
      }

      // History for a given web account id
      if (pathname === '/api/history' && req.method === 'GET') {
        const account = (url.searchParams.get('account') || '').toString();
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        if (!account) return json({ error: 'account is required' }, 400);
        try {
          const db = getDB();
          // Prefer canonical user mapping
          const mapped = resolveUserNpub('web', npub, account);
          let rows: any[];
          if (mapped) {
            rows = db
              .query(
                `SELECT * FROM messages
                 WHERE user_npub = ?
                   AND metadata_json LIKE '%"type":"web"%'
                 ORDER BY created_at ASC
                 LIMIT ?`
              )
              .all(mapped, limit) as any[];
          } else {
            // Fallback: LIKE filters to avoid JSON1
            rows = db
              .query(
                `SELECT * FROM messages
                 WHERE (
                   content_json LIKE ? OR content_json LIKE ?
                 )
                   AND metadata_json LIKE '%"type":"web"%'
                 ORDER BY created_at ASC
                 LIMIT ?`
              )
              .all(`%"from":"${account}"%`, `%"to":"${account}"%`, limit) as any[];
          }
          const items = rows.map((r: any) => ({
            id: r.id,
            conversationId: r.conversation_id,
            direction: r.direction,
            role: r.role,
            content: (() => { try { return JSON.parse(r.content_json); } catch { return {}; } })(),
            createdAt: r.created_at,
          }));
          return json({ items });
        } catch (e: any) {
          return json({ error: 'failed to load history', details: String(e?.message || e) }, 500);
        }
      }

      // Static site
      return serveStatic(pathname);
    },
    websocket: {
      open(ws) {
        const clientId = (ws.data as any)?.clientId || crypto.randomUUID();
        clients.set(clientId, { id: clientId, socket: ws });
        // Send hello with default account if configured
        ws.send(JSON.stringify({ event: 'hello', payload: { clientId, defaultWebId: webId || null } }));
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
            const from = (data?.payload?.from || webId || '').toString();
            if (!text) return;
            if (!from) return;
            // Proxy to REST handler for consistency
            fetch(`http://localhost:${port}/api/send`, { method: 'POST', body: JSON.stringify({ text, from }), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
          }
        } catch {}
      },
    },
  });

  // Outbound consumer: deliver messages targeted to web
  consumeOut((msg) => {
    if (msg.gateway.type !== 'web') return;
    broadcast('outbound', {
      to: msg.to || null,
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
