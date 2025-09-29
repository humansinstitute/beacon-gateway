// Mesh gateway stub
// Expected responsibilities:
// - normalize inbound packets/messages to GatewayInData and call enqueueIn(...)
// - consume outbound (consumeOut) for { type: 'mesh' } and transmit messages
// - include gateway { npub, type: 'mesh' }
// Placeholder only; no enqueue/send yet.

export function startMeshAdapter() {
  console.log('[mesh] adapter stub started (no-op)');
}

