import { consumeBeacon, enqueueOut } from '../queues';
import type { BeaconMessage, GatewayOutData } from '../types';
import { toGatewayOut } from '../types';
import { quickResponseWithAgent } from './callAI.util';
import conversationAgent from './agents/conversationAgent.ts';
import paymentExtract from './agents/paymentExtract';
import { routeIntent } from './intent_router';
import { rememberInbound } from './beacon_store';
import { triggerWingmanForBeacon } from './wingman.client';
import { recordInboundMessage, logAction, createOutboundMessage } from '../db';
import { getEnv } from '../types';
import { payLnAddress as cvmPayLnAddress, getBalance as cvmGetBalance, payLnInvoice as cvmPayLnInvoice, getLNInvoice as cvmGetLNInvoice, getLNAddress as cvmGetLNAddress } from './cvm_client/cvm_client';
import { checkConversation } from './checkConversation';
import { maybeConsolidate } from './conversation/consolidate.util';

// Normalize and sanitize a Lightning invoice string for transport
function normalizeLnInvoice(raw: string): string {
  if (!raw) return raw;
  let s = String(raw).trim();
  // Remove URI scheme if present
  if (/^lightning:/i.test(s)) s = s.replace(/^lightning:/i, '');
  // Strip surrounding quotes/backticks
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1).trim();
  }
  // Remove common trailing punctuation
  s = s.replace(/[\s\r\n]+/g, ''); // drop any whitespace/newlines inside
  s = s.replace(/[\.,;:!?)]$/g, '');
  // Bech32 is case-insensitive but must not be mixed case; use lower
  s = s.toLowerCase();
  // Only forward invoices that look like lnbc... to avoid garbage
  if (!s.startsWith('lnbc')) return raw; // fallback to original if it doesn't look right
  return s;
}

export function startBrainWorker() {
  consumeBeacon(async (msg: BeaconMessage) => {
    try {
      // Determine input text early for conversation analysis
      let text = (msg.source.text || '').trim();
      if (!text) {
        try {
          const parsed = JSON.parse(msg.source.messageData);
          const candidate = (parsed?.body || parsed?.text || '').toString();
          text = (candidate || '').trim();
        } catch {}
      }
      if (!text) {
        // No reasonable text found; skip responding
        console.log('[brain] no text to respond with for beaconID:', msg.beaconID);
        return;
      }

      console.log(`[brain] message received beaconID=${msg.beaconID}`);
      // Ensure userNpub is populated from local map if missing
      if (!msg.meta) msg.meta = {} as any;
      if (!msg.meta.userNpub) {
        try {
          const { resolveUserNpub, resolveUserNpubLoose } = await import('../gateway/npubMap');
          const gw = msg.source.gateway;
          const gatewayUser = msg.source.from || '';
          if (gw?.type && gw?.npub && gatewayUser) {
            const mapped = resolveUserNpub(gw.type as any, gw.npub, gatewayUser);
            if (mapped) {
              msg.meta.userNpub = mapped;
              console.log(`[brain] userNpub resolved (strict) for ${gatewayUser}`);
            } else {
              const loose = resolveUserNpubLoose(gatewayUser);
              if (loose) {
                msg.meta.userNpub = loose;
                console.log(`[brain] userNpub resolved (loose) for ${gatewayUser}`);
              } else {
                console.log(`[brain] userNpub not found for ${gatewayUser}`);
              }
            }
          }
        } catch {}
      }
      // If we still do not have a mapped user npub, inform the user and exit early
      if (!msg.meta?.userNpub) {
        const answer = 'Sorry, you will need to setup your beacon ID to use this service.';
        msg.response = {
          to: msg.source.from || '',
          text: answer,
          quotedMessageId: msg.source.messageId,
          gateway: { ...msg.source.gateway },
        };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '',
          replyToMessageId: undefined,
          role: 'beacon',
          userNpub: null,
          content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
          metadata: { gateway: msg.source.gateway },
          channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
        enqueueOut(out);
        return;
      }

      // Resolve conversation (use analyst when not a reply)
      const isSlash = /^\s*\//.test(text);
      const conv = await checkConversation({ replyToMessageId: undefined, userNpub: msg.meta?.userNpub || null, messageText: isSlash ? '' : text });
      msg.meta = msg.meta || {};
      msg.meta.conversationID = conv.conversationId;
      console.log(`[brain] conversation analysis complete conversationId=${msg.meta.conversationID}`);

      // Persist inbound message and remember routing context
      const inboundMessageId = recordInboundMessage(msg);

      // Consolidate conversation state periodically and prepare history string
      let historyString: string | undefined;
      try {
        const { summary, deltaSinceSummary } = await maybeConsolidate(msg.meta?.conversationID || '');
        if (summary) {
          if (deltaSinceSummary <= 1) {
            historyString = `The previous message history is: ${summary}`;
          } else {
            // stale-ish summary; still useful
            historyString = `Conversation summary: ${summary}`;
          }
        }
      } catch {}
      rememberInbound(msg, inboundMessageId);

      // Route by intent (overrides + LLM); default falls back to AI
      const route = await routeIntent(text, historyString);
      if (route.type === 'wingman') {
        console.log('[intent] route: wingman');
        // Ensure downstream agents get cleaned text (strip slash command if any)
        if (route.text) msg.source.text = route.text;
        const info = await triggerWingmanForBeacon(msg, { historySummary: historyString });
        logAction(msg.beaconID, 'wingman_trigger', info, 'ok');
        return; // wingman webhook will deliver the response
      }

      // Settings: reply with a stubbed message
      if (route.type === 'settings') {
        console.log('[intent] route: settings');
        const answer = 'Sorry settings have not been implemented yet';
        msg.response = {
          to: msg.source.from || '',
          text: answer,
          quotedMessageId: msg.source.messageId,
          gateway: { ...msg.source.gateway },
        };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '',
          replyToMessageId: inboundMessageId,
          role: 'beacon',
          userNpub: msg.meta?.userNpub || null,
          content: {
            text: answer,
            to: msg.source.from || '',
            quotedMessageId: msg.source.messageId,
            beaconId: msg.beaconID,
          },
          metadata: { gateway: msg.source.gateway },
          channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
        console.log(`[brain] outbound queued (settings) deliveryId=${deliveryId} messageId=${messageId}`);
        enqueueOut(out);
        return;
      }

  if (route.type === 'wallet') {
    console.log('[intent] route: wallet');
    // Wallet-related request: extract payment/balance details via agent
    if (route.text) text = route.text;

    // Fast-path: handle /ls to list available commands
    if (text.startsWith('/ls')) {
      const cmds = [
        '/ls - list all commands',
        '/addnick <nickname> <lnAddress> - save a nickname to Lightning Address',
        '/nickls - list your saved nicknames',
        '/nick <nickname> <amount> [sats|$] - pay a saved nickname (USD converts via SATS_PER_DOLLAR)',
        '/newgate <gatewayType> <username> - link another gateway account to your npub (types: whatsapp|signal|nostr|mesh|web)',
      ];
      const answer = `Commands:\n${cmds.join('\n')}`;
      msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
      const { messageId, deliveryId } = createOutboundMessage({
        conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
        content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
        metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
      });
      const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
    }

    // Fast-path: handle /newgate <gatewayType> <username> to add a mapping for this npub
    if (text.startsWith('/newgate')) {
      try {
        const parts = text.split(/\s+/).filter(Boolean);
        const gwTypeRaw = parts[1]?.toLowerCase();
        const gatewayUser = parts[2]?.trim();
        const allowed: Array<'whatsapp'|'signal'|'nostr'|'mesh'|'web'> = ['whatsapp','signal','nostr','mesh','web'];
        if (!gwTypeRaw || !gatewayUser || !allowed.includes(gwTypeRaw as any)) {
          const answer = 'Usage: /newgate <gatewayType> <username>. Example: /newgate web myname';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }
        const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
        if (!npub || !npub.startsWith('npub')) {
          const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }
        const gatewayType = gwTypeRaw as 'whatsapp'|'signal'|'nostr'|'mesh'|'web';
        const gatewayNpub = getEnv('GATEWAY_NPUB', '').trim();
        if (!gatewayNpub) {
          const answer = 'Server misconfiguration: GATEWAY_NPUB is not set.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        const { upsertLocalNpubMap } = await import('../gateway/npubMap');
        upsertLocalNpubMap(gatewayType, gatewayNpub, gatewayUser, npub);

        const answer = `Linked account: ${gatewayType}:${gatewayUser} -> ${npub}`;
        msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
          content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
          metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
      } catch (err) {
        console.error(`[brain] /newgate flow error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
      }
    }

    // Fast-path: handle /nickls to list saved nicknames
    if (text.startsWith('/nickls')) {
      try {
        const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
        if (!npub || !npub.startsWith('npub')) {
          const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }
        const { listNicknames } = await import('../db/nicknames');
        const rows = listNicknames(npub);
        const answer = rows.length === 0
          ? 'No nicknames saved yet. Add one with: /addnick <nickname> <lnAddress>'
          : `Your nicknames:\n` + rows.map(r => `- ${r.nickname} -> ${r.lnAddress}`).join('\n');
        msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
          content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
          metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
      } catch (err) {
        console.error(`[brain] /nickls flow error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
      }
    }

    // Fast-path: handle /addnick <nickname> <lnAddress> without AI
    if (text.startsWith('/addnick')) {
      try {
        const parts = text.split(/\s+/).filter(Boolean);
        const nickname = parts[1]?.toLowerCase();
        const lnAddress = parts[2]?.trim();
        if (!nickname || !lnAddress) {
          const answer = 'Usage: /addnick <nickname> <lnAddress>. Example: /addnick gg dergigi@primal.net';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        // Very light validation for LN address (name@domain)
        const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lnAddress);
        if (!valid) {
          const answer = 'That does not look like a valid Lightning Address. Example: name@domain.tld';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
        if (!npub || !npub.startsWith('npub')) {
          const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        const { upsertNickname } = await import('../db/nicknames');
        upsertNickname(npub, nickname, lnAddress);
        const answer = `Saved nickname: ${nickname} -> ${lnAddress}`;
        msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
          content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
          metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
      } catch (err) {
        console.error(`[brain] /addnick flow error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
      }
    }

    // Fast-path: handle /nick <nickname> <amount> without AI
    if (text.startsWith('/nick')) {
      try {
        const parts = text.split(/\s+/).filter(Boolean);
        const nickname = parts[1]?.toLowerCase();
        const amountStr = parts.slice(2).join(' ').trim();
        if (!nickname || !amountStr) {
          const answer = 'Usage: /nick <nickname> <amount>. Examples: \'/nick paul $5\', \'/nick alice 5000 sats\'';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        // Parse amount and currency
        const lower = amountStr.toLowerCase();
        const satsPerDollar = Number(getEnv('SATS_PER_DOLLAR', '1000')) || 1000;
        let amountSats: number | undefined;
        if (/[\$]|\busd\b/.test(lower)) {
          const m = lower.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
          const usd = m ? parseFloat(m[1]) : NaN;
          if (Number.isFinite(usd) && usd > 0) amountSats = Math.round(usd * satsPerDollar);
        } else if (/sats?\b/.test(lower)) {
          const m = lower.match(/([0-9][0-9_,.]*)/);
          const n = m ? parseInt(m[1].replace(/[,_.]/g, ''), 10) : NaN;
          if (Number.isFinite(n) && n > 0) amountSats = Math.round(n);
        } else {
          // Default to sats if no unit provided
          const m = lower.match(/([0-9][0-9_,.]*)/);
          const n = m ? parseInt(m[1].replace(/[,_.]/g, ''), 10) : NaN;
          if (Number.isFinite(n) && n > 0) amountSats = Math.round(n);
        }

        const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
        if (!npub || !npub.startsWith('npub')) {
          const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }
        if (!amountSats || amountSats <= 0) {
          const answer = 'Could not parse amount. Use $ for dollars or provide sats.';
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        // Lookup nickname
        const { getNickname } = await import('../db/nicknames');
        const rec = getNickname(npub, nickname);
        if (!rec) {
          const answer = `No nickname found for '${nickname}'. Add one via CLI: bun run src/cli/nicknames.ts add ${npub} ${nickname} name@domain.tld`;
          msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
          const { messageId, deliveryId } = createOutboundMessage({
            conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
            content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
            metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
          });
          const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
        }

        const lnAddress = rec.lnAddress;
        const amount = amountSats;
        const responsePubkey = getEnv('BEACON_BRAIN_HEX_PUB', '').trim() ||
          'caabbef036b063f6b29e8bc79f723aae8fb8eddc56fe198f150bae6a01741ee3';

        await cvmPayLnAddress({
          npub,
          refId: msg.beaconID,
          lnAddress,
          amount,
          responsePubkey,
          responseTool: 'confirmPayment',
        });
        logAction(msg.beaconID, 'cvm_payLnAddress', { lnAddress, amount, nickname, responsePubkey: responsePubkey.slice(0,8) + '…' }, 'sent');

        const satsFmt = new Intl.NumberFormat('en-US').format(amount);
        const answer = `I sent a request to pay ${nickname} (${lnAddress}) ${satsFmt} Sats. Awaiting confirmation.`;
        msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
          content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
          metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
      } catch (err) {
        console.error(`[brain] /nick flow error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
      }
    }
        let agentText: string | undefined;
        let parsed: any;
        try {
          logAction(msg.beaconID, 'agent_request', { agent: 'paymentExtract', preview: text.slice(0, 200) });
          agentText = await quickResponseWithAgent(paymentExtract, text, historyString);
          parsed = JSON.parse(agentText);
          logAction(msg.beaconID, 'agent_response', { agent: 'paymentExtract', preview: agentText.slice(0, 200) }, 'ok');
        } catch (err) {
          console.error(`[brain] paymentExtract parse error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
        }

        // Handle receive_invoice by generating an LN invoice via CVM
        if (parsed?.type === 'receive_invoice') {
          try {
            const params = parsed?.parameters || {};
            const amountRaw: unknown = params?.amount;
            const currencyRaw: string = (params?.currency || 'sats').toString().toLowerCase();
            const satsPerDollar = Number(getEnv('SATS_PER_DOLLAR', '1000')) || 1000;

            let amount: number | undefined;
            if (typeof amountRaw === 'number' && Number.isFinite(amountRaw) && amountRaw > 0) {
              amount = (currencyRaw === 'dollars' || currencyRaw === 'usd')
                ? Math.round(amountRaw * satsPerDollar)
                : Math.round(amountRaw);
            }
            const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
            if (!npub || !npub.startsWith('npub')) {
              const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
              msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '',
                replyToMessageId: inboundMessageId,
                role: 'beacon', userNpub: msg.meta?.userNpub || null,
                content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
                metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
            }
            if (!amount) {
              const answer = 'Please specify an amount to generate an invoice.';
              msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
                content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
                metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
            }

            const res = await cvmGetLNInvoice({ npub, refId: msg.beaconID, amount });
            const status = (res as any)?.status || 'error';
            const lnInvoice: string | undefined = (res as any)?.ln_Invoice || (res as any)?.lnInvoice;
            const desc: string = (res as any)?.description || '';

            let answer: string;
            if (status === 'complete' && lnInvoice) {
              const satsFmt = new Intl.NumberFormat('en-US').format(amount);
              answer = `Here’s your Lightning invoice for ${satsFmt} sats:\n${lnInvoice}`;
            } else {
              answer = desc ? `Could not create invoice: ${desc}` : 'Could not create invoice right now.';
            }

            msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
            const { messageId, deliveryId } = createOutboundMessage({
              conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
              content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
              metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
            });
            const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
          } catch (err) {
            console.error(`[brain] cvm getLNInvoice error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
            logAction(msg.beaconID, 'cvm_getLNInvoice', { error: String((err as Error)?.message || err) }, 'failed');
          }
        }

        // Handle get_ln_address via CVM
        if (parsed?.type === 'get_ln_address') {
          try {
            const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
            if (!npub || !npub.startsWith('npub')) {
              const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
              msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
                content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
                metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
            }

            const res = await cvmGetLNAddress({ npub, refId: msg.beaconID });
            const status = (res as any)?.status || 'error';
            const lnAddress: string | undefined = (res as any)?.ln_address || (res as any)?.lnAddress;
            const desc: string = (res as any)?.description || '';

            let answer: string;
            if (status === 'complete' && lnAddress) {
              answer = `Your Lightning address is: ${lnAddress}`;
            } else {
              answer = desc ? `Could not fetch LN address: ${desc}` : 'Could not fetch LN address right now.';
            }

            msg.response = { to: msg.source.from || '', text: answer, quotedMessageId: msg.source.messageId, gateway: { ...msg.source.gateway } };
            const { messageId, deliveryId } = createOutboundMessage({
              conversationId: msg.meta?.conversationID || '', replyToMessageId: inboundMessageId, role: 'beacon', userNpub: msg.meta?.userNpub || null,
              content: { text: answer, to: msg.source.from || '', quotedMessageId: msg.source.messageId, beaconId: msg.beaconID },
              metadata: { gateway: msg.source.gateway }, channel: msg.source.gateway.type,
            });
            const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId }; enqueueOut(out); return;
          } catch (err) {
            console.error(`[brain] cvm getLNAddress error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
            logAction(msg.beaconID, 'cvm_getLNAddress', { error: String((err as Error)?.message || err) }, 'failed');
          }
        }

        // Handle pay_invoice via CVM tool (Lightning invoice)
        if (parsed?.type === 'pay_invoice') {
          try {
            const invoice: string | undefined = parsed?.parameters?.invoice;
            if (invoice && typeof invoice === 'string') {
              const cleanedInvoice = normalizeLnInvoice(invoice);
              const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
              if (!npub || !npub.startsWith('npub')) {
                const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
                msg.response = {
                  to: msg.source.from || '',
                  text: answer,
                  quotedMessageId: msg.source.messageId,
                  gateway: { ...msg.source.gateway },
                };
                const { messageId, deliveryId } = createOutboundMessage({
                  conversationId: msg.meta?.conversationID || '',
                  replyToMessageId: inboundMessageId,
                  role: 'beacon',
                  userNpub: msg.meta?.userNpub || null,
                  content: {
                    text: answer,
                    to: msg.source.from || '',
                    quotedMessageId: msg.source.messageId,
                    beaconId: msg.beaconID,
                  },
                  metadata: { gateway: msg.source.gateway },
                  channel: msg.source.gateway.type,
                });
                const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
                enqueueOut(out);
                return;
              }

              const responsePubkey = '02dbeea53a134f63f9ae917d69738b8b3f17046c54c22bda3edb543b3789c4fa';

              await cvmPayLnInvoice({
                npub,
                refId: msg.beaconID,
                lnInvoice: cleanedInvoice,
                responsePubkey,
                responseTool: 'confirmPayment',
              });
              logAction(
                msg.beaconID,
                'cvm_payLnInvoice',
                { lnInvoice: cleanedInvoice, responsePubkey: responsePubkey },
                'sent'
              );

              const answer = `We’ve sent the request for approval to pay that Lightning invoice.`;

              msg.response = {
                to: msg.source.from || '',
                text: answer,
                quotedMessageId: msg.source.messageId,
                gateway: { ...msg.source.gateway },
              };

              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '',
                replyToMessageId: inboundMessageId,
                role: 'beacon',
                userNpub: msg.meta?.userNpub || null,
                content: {
                  text: answer,
                  to: msg.source.from || '',
                  quotedMessageId: msg.source.messageId,
                  beaconId: msg.beaconID,
                },
                metadata: { gateway: msg.source.gateway },
                channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
              console.log(`[brain] outbound queued deliveryId=${deliveryId} messageId=${messageId}`);
              enqueueOut(out);
              return;
            }
          } catch (err) {
            console.error(`[brain] cvm payLnInvoice error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
            logAction(
              msg.beaconID,
              'cvm_payLnInvoice',
              { error: String((err as Error)?.message || err), lnInvoice: cleanedInvoice },
              'failed'
            );
          }
        }

        // Handle pay_ln_address with extracted data and currency conversion
        if (parsed?.type === 'pay_ln_address') {
          try {
            const params = parsed?.parameters || {};
            const recipient: string | undefined = params.recipient;
            const currencyRaw: string = (params.currency || 'sats').toString().toLowerCase();
            const amountRaw: unknown = params.amount;
            const satsPerDollar = Number(getEnv('SATS_PER_DOLLAR', '1000')) || 1000;

            let amountSats: number | undefined;
            if (typeof amountRaw === 'number' && Number.isFinite(amountRaw)) {
              amountSats = (currencyRaw === 'dollars' || currencyRaw === 'usd')
                ? Math.round(amountRaw * satsPerDollar)
                : Math.round(amountRaw);
            }

            if (recipient && amountSats && amountSats > 0) {
              const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
              if (!npub || !npub.startsWith('npub')) {
                const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
                msg.response = {
                  to: msg.source.from || '',
                  text: answer,
                  quotedMessageId: msg.source.messageId,
                  gateway: { ...msg.source.gateway },
                };
                const { messageId, deliveryId } = createOutboundMessage({
                  conversationId: msg.meta?.conversationID || '',
                  replyToMessageId: inboundMessageId,
                  role: 'beacon',
                  userNpub: msg.meta?.userNpub || null,
                  content: {
                    text: answer,
                    to: msg.source.from || '',
                    quotedMessageId: msg.source.messageId,
                    beaconId: msg.beaconID,
                  },
                  metadata: { gateway: msg.source.gateway },
                  channel: msg.source.gateway.type,
                });
                const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
                enqueueOut(out);
                return;
              }
              const lnAddress = recipient;
              const amount = amountSats;
              const responsePubkey = getEnv('BEACON_BRAIN_HEX_PUB', '').trim() ||
                'caabbef036b063f6b29e8bc79f723aae8fb8eddc56fe198f150bae6a01741ee3';

              await cvmPayLnAddress({
                npub,
                refId: msg.beaconID,
                lnAddress,
                amount,
                responsePubkey,
                responseTool: 'confirmPayment',
              });
              logAction(msg.beaconID, 'cvm_payLnAddress', { lnAddress, amount, responsePubkey: responsePubkey.slice(0,8) + '…' }, 'sent');

              const satsFmt = new Intl.NumberFormat('en-US').format(amount);
              const answer = `I sent a request to your Beacon ID to pay ${lnAddress} ${satsFmt} Sats. Just waiting on confirmation.`;

              msg.response = {
                to: msg.source.from || '',
                text: answer,
                quotedMessageId: msg.source.messageId,
                gateway: { ...msg.source.gateway },
              };

              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '',
                replyToMessageId: inboundMessageId,
                role: 'beacon',
                userNpub: msg.meta?.userNpub || null,
                content: {
                  text: answer,
                  to: msg.source.from || '',
                  quotedMessageId: msg.source.messageId,
                  beaconId: msg.beaconID,
                },
                metadata: { gateway: msg.source.gateway },
                channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
              console.log(`[brain] outbound queued deliveryId=${deliveryId} messageId=${messageId}`);
              enqueueOut(out);
              return;
            }

            // Missing recipient or amount; fall through to info response with extracted details
          } catch (err) {
            console.error(`[brain] cvm payLnAddress (extracted) error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
            logAction(msg.beaconID, 'cvm_payLnAddress', { error: String((err as Error)?.message || err) }, 'failed');
          }
        }

        // Handle balance queries using CVM getBalance tool
        if (parsed?.type === 'balance') {
          try {
            const npub = (msg.meta?.userNpub && String(msg.meta.userNpub)) || '';
            if (!npub || !npub.startsWith('npub')) {
              const answer = 'I could not determine your npub. Please link your WhatsApp to a Beacon ID first.';
              msg.response = {
                to: msg.source.from || '',
                text: answer,
                quotedMessageId: msg.source.messageId,
                gateway: { ...msg.source.gateway },
              };
              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '',
                replyToMessageId: inboundMessageId,
                role: 'beacon',
                userNpub: msg.meta?.userNpub || null,
                content: {
                  text: answer,
                  to: msg.source.from || '',
                  quotedMessageId: msg.source.messageId,
                  beaconId: msg.beaconID,
                },
                metadata: { gateway: msg.source.gateway },
                channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
              enqueueOut(out);
              return;
            }
            const res = await cvmGetBalance({ npub, refId: msg.beaconID });
            const status = (res as any)?.status || 'complete';
            const balance: number | undefined = (res as any)?.balance;

            if (status === 'complete' && typeof balance === 'number' && Number.isFinite(balance)) {
              const sats = Math.round(balance);
              const satsPerDollar = Number(getEnv('SATS_PER_DOLLAR', '1000')) || 1000;
              const dollars = satsPerDollar > 0 ? (sats / satsPerDollar) : 0;
              const satsFmt = new Intl.NumberFormat('en-US').format(sats);
              const usdFmt = dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const answer = `Your current balance is ${satsFmt} Sats ($ ${usdFmt})`;
              logAction(msg.beaconID, 'balance_response', { balance }, 'ok');

              msg.response = {
                to: msg.source.from || '',
                text: answer,
                quotedMessageId: msg.source.messageId,
                gateway: { ...msg.source.gateway },
              };

              const { messageId, deliveryId } = createOutboundMessage({
                conversationId: msg.meta?.conversationID || '',
                replyToMessageId: inboundMessageId,
                role: 'beacon',
                userNpub: msg.meta?.userNpub || null,
                content: {
                  text: answer,
                  to: msg.source.from || '',
                  quotedMessageId: msg.source.messageId,
                  beaconId: msg.beaconID,
                },
                metadata: { gateway: msg.source.gateway },
                channel: msg.source.gateway.type,
              });
              const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
              console.log(`[brain] outbound queued deliveryId=${deliveryId} messageId=${messageId}`);
              enqueueOut(out);
              return;
            } else {
              console.error('[brain] getBalance unexpected response');
            }
          } catch (err) {
            console.error(`[brain] cvm getBalance error beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
            logAction(msg.beaconID, 'cvm_getBalance', { error: String((err as Error)?.message || err) }, 'failed');
          }
        }

        // Any other type or fallback: log details and inform user
        const details = (() => {
          try { return parsed ? JSON.stringify(parsed) : (agentText || ''); } catch { return String(agentText || ''); }
        })();
        console.log('[brain] wallet flow fallback response sent');

        const answer = `No worries. I extracted these details and processed the request\n\n${details}`;
        logAction(msg.beaconID, 'info_response', { answerPreview: answer.slice(0, 200) }, 'ok');

        msg.response = {
          to: msg.source.from || '',
          text: answer,
          quotedMessageId: msg.source.messageId,
          gateway: { ...msg.source.gateway },
        };

        const { messageId, deliveryId } = createOutboundMessage({
          conversationId: msg.meta?.conversationID || '',
          replyToMessageId: inboundMessageId,
          role: 'beacon',
          userNpub: msg.meta?.userNpub || null,
          content: {
            text: answer,
            to: msg.source.from || '',
            quotedMessageId: msg.source.messageId,
            beaconId: msg.beaconID,
          },
          metadata: { gateway: msg.source.gateway },
          channel: msg.source.gateway.type,
        });
        const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
        console.log(`[brain] outbound queued deliveryId=${deliveryId} messageId=${messageId}`);
        enqueueOut(out);
        return;
      }

      // Conversation/default flow
      if (route.type === 'default') {
        console.log('[intent] route: conversation');
      }
      if ((route as any).text) text = (route as any).text;
      logAction(msg.beaconID, 'ai_request', { agent: 'conversation', preview: text.slice(0, 200) });
      const answer = await quickResponseWithAgent(conversationAgent, text, historyString);
      logAction(msg.beaconID, 'ai_response', { answerPreview: answer.slice(0, 200) }, 'ok');

      // Populate response envelope
      msg.response = {
        to: msg.source.from || '',
        text: answer,
        quotedMessageId: msg.source.messageId,
        gateway: { ...msg.source.gateway },
      };

      // For now, convert to legacy outbound for adapters
      // Create outbound message + delivery (queued)
      const { messageId, deliveryId } = createOutboundMessage({
        conversationId: msg.meta?.conversationID || '',
        replyToMessageId: inboundMessageId,
        role: 'beacon',
        userNpub: msg.meta?.userNpub || null,
        content: {
          text: answer,
          to: msg.source.from || '',
          quotedMessageId: msg.source.messageId,
          beaconId: msg.beaconID,
        },
        metadata: { gateway: msg.source.gateway },
        channel: msg.source.gateway.type,
      });

      const out: GatewayOutData = { ...toGatewayOut(msg), deliveryId, messageId };
      console.log(`[brain] outbound queued deliveryId=${deliveryId} messageId=${messageId}`);
      enqueueOut(out);
    } catch (err) {
      console.error(`[brain] error handling message beaconID=${msg.beaconID}: ${String((err as Error)?.message || err)}`);
      logAction(msg.beaconID, 'error', { message: String((err as Error)?.message || err) }, 'failed');
    }
  });
  console.log('[brain] worker started');
}
