import { consumeBeacon } from '../../queues';
import type { BeaconMessage } from '../../types';
import { getEnv } from '../../types';
import { GatewayCvmClient, type ReceiveMessageRequest } from './client';
import { transitionDelivery } from '../../db';

/**
 * Dispatches Beacon messages with response to remote gateways via Context VM.
 * Requires GATEWAY_MODE=cvm.
 */
export function startCvmDispatcher() {
  const mode = (getEnv('GATEWAY_MODE', '').toLowerCase());
  if (mode !== 'cvm') {
    console.log('[cvm-dispatch] skipped (GATEWAY_MODE!=cvm)');
    return;
  }
  console.log('[cvm-dispatch] starting (GATEWAY_MODE=cvm)');

  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      if (!msg.response) return; // only dispatch when a response is present
      const ctx = (msg.meta?.ctx || {}) as Record<string, unknown>;
      const returnGatewayID = String(ctx.returnGatewayID || '');
      const networkID = String(ctx.networkID || msg.response.gateway?.type || '');
      if (!returnGatewayID || !/^[0-9a-fA-F]{64}$/.test(returnGatewayID)) {
        console.error('[cvm-dispatch] missing/invalid returnGatewayID for beacon', { beaconID: msg.beaconID });
        return;
      }
      if (!networkID) {
        console.error('[cvm-dispatch] missing networkID in ctx', { beaconID: msg.beaconID });
        return;
      }

      const userId = String(ctx.userId || msg.response.to || msg.source.from || '');
      const botType = String(ctx.botType || 'brain');
      const req: ReceiveMessageRequest = {
        refId: msg.beaconID,
        returnGatewayID,
        networkID,
        botid: String(ctx.botid || ''),
        botType,
        groupID: (ctx.groupID as string | undefined) || undefined,
        userId: userId || undefined,
        messageID: msg.response.quotedMessageId || undefined,
        message: String(msg.response.text || ''),
      };

      const client = new GatewayCvmClient(returnGatewayID);
      console.log('[cvm-dispatch] call receiveMessage ->', { target: returnGatewayID.slice(0,8) + '…', beaconID: msg.beaconID });
      const res = await client.receiveMessage(req);
      const deliveryId = String((msg.meta?.ctx as any)?.deliveryId || '');
      if (deliveryId) {
        if (res?.status === 'success') {
          transitionDelivery(deliveryId, 'sent');
        } else {
          transitionDelivery(deliveryId, 'failed', { errorMessage: res?.description || 'gateway failure' });
        }
      }
      console.log('[cvm-dispatch] dispatched', { beaconID: msg.beaconID, status: res?.status });
    } catch (err) {
      const deliveryId = String((msg.meta?.ctx as any)?.deliveryId || '');
      if (deliveryId) transitionDelivery(deliveryId, 'failed', { errorMessage: String((err as Error)?.message || err) });
      console.error('[cvm-dispatch] error', { beaconID: msg.beaconID, err });
    }
  });
}
