import { EventEmitter } from 'events';
import type { GatewayInData, GatewayOutData } from '../types';

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
