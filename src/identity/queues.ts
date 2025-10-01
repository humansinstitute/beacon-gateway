// src/identity/queues.ts
// This file defines the dedicated queues for the Identity service,
// ensuring its message bus is isolated from the Brain service.

import { EventEmitter } from 'events';
import type { BeaconMessage, GatewayInData, GatewayOutData } from '../types';

const identityBus = new EventEmitter();

// Inbound queue for the Identity service
export function enqueueIdentityIn(msg: GatewayInData): void {
  queueMicrotask(() => identityBus.emit('in', msg));
}

export function consumeIdentityIn(handler: (msg: GatewayInData) => Promise<void> | void): void {
  identityBus.on('in', (msg: GatewayInData) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('[identity] consumeIn handler error:', err));
  });
}

// Outbound queue for the Identity service
export function enqueueIdentityOut(msg: GatewayOutData): void {
  queueMicrotask(() => identityBus.emit('out', msg));
}

export function consumeIdentityOut(handler: (msg: GatewayOutData) => Promise<void> | void): void {
  identityBus.on('out', (msg: GatewayOutData) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('[identity] consumeOut handler error:', err));
  });
}

// Beacon envelope queue for the Identity service
export function enqueueIdentityBeacon(msg: BeaconMessage): void {
  queueMicrotask(() => identityBus.emit('beacon', msg));
}

export function consumeIdentityBeacon(handler: (msg: BeaconMessage) => Promise<void> | void): void {
  identityBus.on('beacon', (msg: BeaconMessage) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('[identity] consumeBeacon handler error:', err));
  });
}
