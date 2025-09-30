import { getDB } from '../db';
import type { GatewayType } from '../types';

export function resolveUserNpub(
  gatewayType: GatewayType,
  gatewayNpub: string,
  gatewayUser: string,
): string | undefined {
  try {
    const db = getDB();
    const row = db
      .query(
        `SELECT user_npub FROM local_npub_map WHERE gateway_type = ? AND gateway_npub = ? AND gateway_user = ?`
      )
      .get(gatewayType, gatewayNpub, gatewayUser) as any;
    return row?.user_npub || undefined;
  } catch {
    return undefined;
  }
}

