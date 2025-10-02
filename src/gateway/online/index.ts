import { consumeBeacon, consumeOut } from '../../queues';
import { consumeIdentityBeacon, consumeIdentityOut } from '../../identity/queues';
import type { BeaconMessage, GatewayOutData } from '../../types';
import { getOutboundContext } from '../../brain/beacon_store';
import { sendBeaconOnlineMessage } from '../../brain/cvm_client/cvm_client';

type OnlineType = 'online_id' | 'online_brain';

function looksLikeNpub(s: string | undefined | null): s is string {
  return !!s && s.startsWith('npub');
}

export function startOnlineAdapter(opts?: { type?: OnlineType }) {
  const type: OnlineType = (opts?.type === 'online_id' || opts?.type === 'online_brain') ? opts.type : 'online_brain';
  // No CVM send from this adapter in this mode; just log detections.

  async function handle(msg: BeaconMessage) {
    try {
      // Prefer response text (Brain/ID generated), fallback to source text
      const text = (msg.response?.text || msg.source.text || '').toString();
      if (!text) return; // nothing to send

      // Pull routing context established on inbound
      const ctx = getOutboundContext(msg.beaconID);
      const localGatewayID = ctx?.to || msg.response?.to || msg.source.from || '';
      const originGatewayNpub = ctx?.gateway?.npub;

      if (!localGatewayID || !originGatewayNpub) {
        console.warn('[online-adapter] missing routing context', { beaconID: msg.beaconID, hasLocalId: !!localGatewayID, hasGatewayNpub: !!originGatewayNpub });
        return;
      }
      console.log('[online-adapter] queue event (BeaconMessage)', {
        beaconID: msg.beaconID,
        gatewayID: localGatewayID,
        gatewayNpub: originGatewayNpub,
        type,
        preview: text.slice(0, 140),
      });
    } catch (err) {
      console.error('[online-adapter] handler error', err);
    }
  }

  // Consume both Brain and Identity beacon queues (inbound envelopes).
  // These are useful if the response is attached directly to the BeaconMessage (rare).
  consumeBeacon(handle);
  consumeIdentityBeacon(handle);

  // Primary delivery: consume outbound gateway messages targeting the 'web' gateway
  const handleOut = async (out: GatewayOutData) => {
    try {
      if (out.gateway.type !== 'web') return; // only forward messages destined for beacon_online
      const gatewayNpub = out.gateway.npub;
      const gatewayID = out.to || '';
      const text = out.body || '';
      if (!gatewayNpub || !gatewayID || !text) return;
      console.log('[online-adapter] queue event (GatewayOutData)', {
        refId: out.messageId || '',
        gatewayID,
        gatewayNpub,
        type,
        preview: text.slice(0, 140),
      });

      // Send to beacon_online via CVM tool call
      const result: any = await sendBeaconOnlineMessage({
        gatewayID,
        gatewayNpub,
        type,
        message: text,
        refId: out.messageId || out.deliveryId,
      }).catch((err: unknown) => {
        console.error('[online-adapter] send error', { refId: out.messageId || '', error: (err as Error)?.message || String(err) });
        throw err;
      });
      try {
        const status = (result && typeof result === 'object' && 'status' in result) ? (result as any).status : 'unknown';
        console.log('[online-adapter] sent to beacon_online', { refId: out.messageId || '', status });
      } catch {
        console.log('[online-adapter] sent to beacon_online', { refId: out.messageId || '', status: 'ok' });
      }
    } catch (err) {
      console.error('[online-adapter] handleOut error', err);
    }
  };
  consumeOut(handleOut);
  consumeIdentityOut(handleOut);

  console.log('[online-adapter] started', { type });
}
