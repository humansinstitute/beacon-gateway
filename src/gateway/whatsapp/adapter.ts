import qrcode from 'qrcode-terminal';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import { consumeOut, enqueueBeacon } from '../../queues';
import type { GatewayOutData, BeaconMessage } from '../../types';
import { getEnv, toBeaconMessage } from '../../types';
import { transitionDelivery } from '../../db';
import { ensureMappedOrPrompt } from '../unknownUser';

function resolveContactName(contact: any): string | undefined {
  const candidate = (
    (contact?.pushname || contact?.name || contact?.verifiedName || contact?.shortName || '').trim()
  );
  if (candidate && candidate !== 'WhatsApp User') return candidate;
  return contact?.number || contact?.id?.user || undefined;
}

export function startWhatsAppAdapter() {
  const SESSION_DIR = getEnv('SESSION_DIR', '.wwebjs_auth');
  const HEADLESS = getEnv('HEADLESS', 'true').toLowerCase() !== 'false';
  const NO_SANDBOX = getEnv('NO_SANDBOX', 'false').toLowerCase() === 'true';
  const EXECUTABLE_PATH = getEnv('PUPPETEER_EXECUTABLE_PATH', getEnv('CHROME_BIN', '')) || undefined;
  const GATEWAY_NPUB = getEnv('GATEWAY_NPUB', '');

  const pupArgs = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=site-per-process,Translate,BackForwardCache',
  ];
  if (NO_SANDBOX) pupArgs.push('--no-sandbox', '--disable-setuid-sandbox');

  const client = new Client({
    puppeteer: {
      headless: HEADLESS,
      args: pupArgs,
      executablePath: EXECUTABLE_PATH,
    },
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  });

  client.on('qr', (qr) => {
    console.log('[whatsapp] Scan this QR to authenticate:');
    try { qrcode.generate(qr, { small: true }); } catch { console.log('QR (raw):', qr); }
  });
  client.on('ready', () => console.log('[whatsapp] READY'));
  client.on('authenticated', () => console.log('[whatsapp] authenticated'));
  client.on('auth_failure', (msg) => console.error('[whatsapp] auth_failure:', msg));
  client.on('disconnected', (reason) => console.warn('[whatsapp] disconnected:', reason));

  client.on('message', async (msg) => {
    try {
      // Ignore messages sent by this account to avoid echo loops
      if ((msg as any)?.fromMe) return;
      let contactName: string | undefined;
      try { const contact = await msg.getContact(); contactName = resolveContactName(contact); } catch {}
      let chatName: string | undefined;
      try { const chat = await msg.getChat(); // group or private
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatName = (chat as any)?.name || undefined;
      } catch {}

      // Build a beacon envelope capturing both normalized and raw data
      const rawSnapshot = {
        provider: 'whatsapp',
        id: msg.id,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        hasMedia: msg.hasMedia,
        timestamp: (msg as any)?.timestamp,
        ack: (msg as any)?.ack,
        deviceType: (msg as any)?.deviceType,
        type: (msg as any)?.type,
        author: (msg as any)?.author,
        mentionedIds: (msg as any)?.mentionedIds,
        quotedMsgId: (msg as any)?._data?.quotedMsgId || (msg as any)?._data?.quotedStanzaID,
        chat: chatName,
        contact: contactName,
      };

      const beacon: BeaconMessage = toBeaconMessage(
        rawSnapshot,
        { npub: GATEWAY_NPUB, type: 'whatsapp' },
        {
          from: msg.from,
          messageId: msg.id?.id,
          text: msg.body,
          hasMedia: msg.hasMedia,
        }
      );
      // Map gateway user to a canonical user npub via local DB mapping (if present)
      const mapped = await ensureMappedOrPrompt('whatsapp', GATEWAY_NPUB, msg.from, (text) => client.sendMessage(msg.from, text));
      if (!mapped) return; // do not enqueue until user is mapped
      beacon.meta.userNpub = mapped;
      enqueueBeacon(beacon);
    } catch (e) {
      console.error('[whatsapp] error handling message:', e);
    }
  });

  // Outbound consumer: send only messages for this gateway npub/type
  consumeOut(async (out: GatewayOutData) => {
    if (out.gateway.type !== 'whatsapp') return;
    if (GATEWAY_NPUB && out.gateway.npub !== GATEWAY_NPUB) return;

    try {
      console.log('[whatsapp] sending outbound message:', {
        to: out.to,
        body: out.body,
        media: !!out.mediaBase64,
        mediaMime: out.mediaMime,
        quotedMessageId: out.quotedMessageId,
        deliveryId: out.deliveryId,
        gateway: out.gateway,
      });
      const sendResult = await (async () => {
        if (out.mediaBase64) {
          const media = new MessageMedia(out.mediaMime || 'application/octet-stream', out.mediaBase64);
          return client.sendMessage(out.to, media, { caption: out.body || undefined, quotedMessageId: out.quotedMessageId });
        } else {
          return client.sendMessage(out.to, out.body || '', { quotedMessageId: out.quotedMessageId });
        }
      })();
      try {
        if (out.deliveryId) {
          const providerId = (sendResult as any)?.id?.id || (sendResult as any)?.id?._serialized || undefined;
          transitionDelivery(out.deliveryId, 'sent', { providerMessageId: providerId });
        }
      } catch (e) {
        console.warn('[whatsapp] delivery transition failed:', e);
      }
    } catch (err) {
      console.error('[whatsapp] send failed:', err);
      try {
        if (out.deliveryId) {
          transitionDelivery(out.deliveryId, 'failed', { errorMessage: String((err as Error)?.message || err) });
        }
      } catch (e) {
        console.warn('[whatsapp] delivery fail transition error:', e);
      }
    }
  });

  client.initialize().catch((err) => console.error('[whatsapp] init failed:', err));

  console.log('[whatsapp] adapter started');
}
