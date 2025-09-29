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
