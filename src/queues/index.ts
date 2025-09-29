import { EventEmitter } from 'events';
import type { BeaconMessage, GatewayInData, GatewayOutData } from '../types';

const bus = new EventEmitter();

// Inbound queue API
export function enqueueIn(msg: GatewayInData): void {
  queueMicrotask(() => bus.emit('in', msg));
}

export function consumeIn(handler: (msg: GatewayInData) => Promise<void> | void): void {
  bus.on('in', (msg: GatewayInData) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('consumeIn handler error:', err));
  });
}

// Outbound queue API
export function enqueueOut(msg: GatewayOutData): void {
  queueMicrotask(() => bus.emit('out', msg));
}

export function consumeOut(handler: (msg: GatewayOutData) => Promise<void> | void): void {
  bus.on('out', (msg: GatewayOutData) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('consumeOut handler error:', err));
  });
}

// Beacon envelope queue API (generalized lifecycle)
export function enqueueBeacon(msg: BeaconMessage): void {
  queueMicrotask(() => bus.emit('beacon', msg));
}

export function consumeBeacon(handler: (msg: BeaconMessage) => Promise<void> | void): void {
  bus.on('beacon', (msg: BeaconMessage) => {
    Promise.resolve(handler(msg)).catch((err) => console.error('consumeBeacon handler error:', err));
  });
}
