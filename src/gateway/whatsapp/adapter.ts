import qrcode from 'qrcode-terminal';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import { consumeOut, enqueueIn } from '../../queues';
import type { GatewayInData, GatewayOutData } from '../../types';
import { getEnv } from '../../types';

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
      let contactName: string | undefined;
      try { const contact = await msg.getContact(); contactName = resolveContactName(contact); } catch {}
      let chatName: string | undefined;
      try { const chat = await msg.getChat(); // group or private
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatName = (chat as any)?.name || undefined;
      } catch {}

      const inMsg: GatewayInData = {
        from: msg.from,
        contact: contactName,
        chat: chatName,
        body: msg.body,
        hasMedia: msg.hasMedia,
        originalMessageId: msg.id?.id,
        gateway: { npub: GATEWAY_NPUB, type: 'whatsapp' },
      };
      enqueueIn(inMsg);
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
        gateway: out.gateway,
      });
      if (out.mediaBase64) {
        const media = new MessageMedia(out.mediaMime || 'application/octet-stream', out.mediaBase64);
        await client.sendMessage(out.to, media, { caption: out.body || undefined, quotedMessageId: out.quotedMessageId });
      } else {
        await client.sendMessage(out.to, out.body || '', { quotedMessageId: out.quotedMessageId });
      }
    } catch (err) {
      console.error('[whatsapp] send failed:', err);
    }
  });

  client.initialize().catch((err) => console.error('[whatsapp] init failed:', err));

  console.log('[whatsapp] adapter started');
}
