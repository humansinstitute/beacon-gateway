// Signal gateway stub
// Provide a client that can:
// - normalize inbound to GatewayInData and call enqueueIn(...)
// - consume outbound (consumeOut) for { type: 'signal' } and send messages
// - include gateway { npub, type: 'signal' }
// For now, this is a placeholder and does not enqueue or send anything.

export function startSignalAdapter() {
  console.log('[signal] adapter stub started (no-op)');
}

