// In-memory store to map beaconID -> outbound routing context
// Used to route webhook responses back to the correct destination/gateway.

import type { BeaconMessage, GatewayInfo } from '../types';

type OutboundContext = {
  to: string;
  quotedMessageId?: string;
  gateway: GatewayInfo;
  inboundMessageId?: string; // DB id of inbound message for reply linkage
  conversationId?: string;
  userNpub?: string;
};

const map = new Map<string, OutboundContext>();
const MAX_ENTRIES = 2000;

export function rememberInbound(msg: BeaconMessage, inboundMessageId?: string): void {
  const to = msg.source.from || '';
  const quotedMessageId = msg.source.messageId;
  const gateway = msg.source.gateway;
  const conversationId = msg.meta?.conversationID;
  const userNpub = msg.meta?.userNpub;
  if (!msg.beaconID || !to) return;
  // Simple LRU-ish eviction
  if (map.size >= MAX_ENTRIES) {
    const firstKey = map.keys().next().value as string | undefined;
    if (firstKey) map.delete(firstKey);
  }
  map.set(msg.beaconID, { to, quotedMessageId, gateway, inboundMessageId, conversationId, userNpub });
}

export function getOutboundContext(beaconID: string): OutboundContext | undefined {
  return map.get(beaconID);
}

export function forget(beaconID: string): void {
  map.delete(beaconID);
}
