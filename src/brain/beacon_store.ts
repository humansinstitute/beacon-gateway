// In-memory store to map beaconID -> outbound routing context
// Used to route webhook responses back to the correct destination/gateway.

import type { BeaconMessage, GatewayInfo } from '../types';

type OutboundContext = {
  to: string;
  quotedMessageId?: string;
  gateway: GatewayInfo;
};

const map = new Map<string, OutboundContext>();
const MAX_ENTRIES = 2000;

export function rememberInbound(msg: BeaconMessage): void {
  const to = msg.source.from || '';
  const quotedMessageId = msg.source.messageId;
  const gateway = msg.source.gateway;
  if (!msg.beaconID || !to) return;
  // Simple LRU-ish eviction
  if (map.size >= MAX_ENTRIES) {
    const firstKey = map.keys().next().value as string | undefined;
    if (firstKey) map.delete(firstKey);
  }
  map.set(msg.beaconID, { to, quotedMessageId, gateway });
}

export function getOutboundContext(beaconID: string): OutboundContext | undefined {
  return map.get(beaconID);
}

export function forget(beaconID: string): void {
  map.delete(beaconID);
}

