import type { GatewayType } from '../types';
import { resolveUserNpub } from './npubMap';

export const UNKNOWN_USER_PROMPT = 'Please setup your Beacon ID first for access to beacon!';

// In-memory throttle to avoid duplicate prompts for the same gateway user
const lastPromptAt: Map<string, number> = new Map();
const PROMPT_THROTTLE_MS = 60_000; // 60s

function key(gatewayType: GatewayType, gatewayNpub: string, gatewayUser: string) {
  return `${gatewayType}|${gatewayNpub}|${gatewayUser}`;
}

/**
 * Returns mapped npub if known; otherwise invokes `prompt` and returns undefined.
 * Adapter supplies a prompt function appropriate to its transport.
 */
export async function ensureMappedOrPrompt(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
  prompt: (text: string) => Promise<void> | void,
): Promise<string | undefined> {
  const mapped = resolveUserNpub(gatewayType, gatewayNpub, gatewayUser);
  if (mapped) return mapped;
  const k = key(gatewayType, gatewayNpub, gatewayUser);
  const now = Date.now();
  const last = lastPromptAt.get(k) || 0;
  if (now - last >= PROMPT_THROTTLE_MS) {
    lastPromptAt.set(k, now);
    try { await Promise.resolve(prompt(UNKNOWN_USER_PROMPT)); } catch {}
  }
  return undefined;
}
