// Nostr gateway stub
// Expected responsibilities:
// - normalize inbound events to GatewayInData and call enqueueIn(...)
// - consume outbound (consumeOut) for { type: 'nostr' } and publish messages
// - include gateway { npub, type: 'nostr' }
// Placeholder only; no enqueue/send yet.

export function startNostrAdapter() {
  console.log('[nostr] adapter stub started (no-op)');
}

