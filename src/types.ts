export type GatewayType = 'whatsapp' | 'signal' | 'nostr' | 'mesh';

export interface GatewayInfo {
  npub: string;
  type: GatewayType;
}

export interface GatewayInData {
  from: string;
  contact?: string;
  chat?: string;
  body: string;
  hasMedia?: boolean;
  mediaBase64?: string;
  mediaMime?: string;
  originalMessageId?: string;
  gateway: GatewayInfo;
}

export interface GatewayOutData {
  to: string;
  body?: string;
  mediaBase64?: string;
  mediaMime?: string;
  quotedMessageId?: string;
  gateway: GatewayInfo;
}

export function getEnv(key: string, fallback?: string): string {
  // Supports Bun.env and process.env
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunEnv = (typeof (globalThis as any).Bun !== 'undefined' && (globalThis as any).Bun.env?.[key]) || undefined;
  const nodeEnv = (typeof process !== 'undefined' && process.env?.[key]) || undefined;
  return (bunEnv ?? nodeEnv ?? fallback ?? '').toString();
}

// -------------------- Beacon Envelope (generalized across gateways) --------------------

export interface BeaconSource {
  gateway: GatewayInfo;
  from?: string;
  messageId?: string;
  text?: string;
  hasMedia?: boolean;
  /** Stringified raw provider payload (always present) */
  messageData: string;
}

export interface BeaconResponse {
  to: string;
  text?: string;
  mediaBase64?: string;
  mediaMime?: string;
  quotedMessageId?: string;
  gateway: GatewayInfo;
}

export interface BeaconMeta {
  conversationID?: string;
  flowID?: string;
  userNpub?: string;
}

export interface BeaconMessage {
  beaconID: string;
  source: BeaconSource;
  meta: BeaconMeta;
  response?: BeaconResponse;
}

/** Lightweight UUID; prefer crypto.randomUUID when available */
function genBeaconId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try {
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {}
  return 'bcn-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

/**
 * Creates a BeaconMessage envelope from raw provider data and optional normalized fields.
 */
export function toBeaconMessage(
  raw: unknown,
  gateway: GatewayInfo,
  normalized: Partial<Pick<BeaconSource, 'from' | 'messageId' | 'text' | 'hasMedia'>> = {}
): BeaconMessage {
  let messageData = '';
  try {
    messageData = JSON.stringify(raw ?? {});
  } catch {
    messageData = JSON.stringify({ error: 'unserializable', type: typeof raw });
  }
  return {
    beaconID: genBeaconId(),
    source: {
      gateway,
      from: normalized.from,
      messageId: normalized.messageId,
      text: normalized.text,
      hasMedia: normalized.hasMedia,
      messageData,
    },
    meta: {},
  };
}

/**
 * Converts a BeaconMessage with response into legacy GatewayOutData for existing adapters.
 */
export function toGatewayOut(msg: BeaconMessage): GatewayOutData {
  if (!msg.response) throw new Error('toGatewayOut: response is missing');
  return {
    to: msg.response.to,
    body: msg.response.text,
    mediaBase64: msg.response.mediaBase64,
    mediaMime: msg.response.mediaMime,
    quotedMessageId: msg.response.quotedMessageId,
    gateway: msg.response.gateway,
  };
}
