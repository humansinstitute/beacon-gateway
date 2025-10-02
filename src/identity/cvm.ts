// src/identity/cvm.ts
// This module manages the ContextVM server and client for the Identity service.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { ApplesauceRelayPool, NostrServerTransport, NostrClientTransport, PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";
import { getEnv } from "../types";
import { PendingPayment } from "./pending_store";
import { enqueueIdentityOut } from "./queues";
import { storePendingConfirmation, retrieveAndClearConfirmation } from "./pending_store";
import { getDB } from "../db";
import { makePayment, getBalance, createInvoice, getLNAddress } from "./wallet_manager";
import { nip19 } from 'nostr-tools';
import { decode } from 'light-bolt11-decoder';

// A helper to get npub from a hex pubkey
function toNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

// --- Configuration ---
const RELAYS = ["wss://cvm.otherstuff.ai"];

// --- Idempotency Cache ---
const processedRefIds = new Set<string>();
function isRefIdProcessed(refId: string): boolean {
  if (processedRefIds.has(refId)) {
    console.log(`[CVM] Duplicate refId '${refId}' detected. Ignoring.`);
    return true;
  }
  return false;
}
function markRefIdAsProcessed(refId: string): void {
  processedRefIds.add(refId);
  console.log(`[CVM] refId '${refId}' marked as processed.`);
  setTimeout(() => processedRefIds.delete(refId), 5 * 60 * 1000); // 5 minute TTL
}

// --- DB Helpers ---
function findGatewayUserByNpub(npub: string): string | null {
  try {
    const db = getDB();
    const gatewayNpub = getEnv('GATEWAY_NPUB', '').trim();
    const row = db.query(
      `SELECT gateway_user FROM local_npub_map WHERE user_npub = ? AND gateway_npub = ? ORDER BY created_at DESC LIMIT 1`
    ).get(npub, gatewayNpub) as any;
    return row?.gateway_user || null;
  } catch (err) {
    console.error(`[CVM] Database error looking up npub ${npub}:`, err);
    return null;
  }
}

function findGatewayUserByNpubForType(npub: string, gatewayType: 'web' | 'whatsapp'): string | null {
  try {
    const db = getDB();
    const gatewayNpub = getEnv('GATEWAY_NPUB', '').trim();
    const row = db.query(
      `SELECT gateway_user FROM local_npub_map WHERE user_npub = ? AND gateway_npub = ? AND gateway_type = ? ORDER BY created_at DESC LIMIT 1`
    ).get(npub, gatewayNpub, gatewayType) as any;
    return row?.gateway_user || null;
  } catch (err) {
    console.error(`[CVM] DB error looking up npub ${npub} for ${gatewayType}:`, err);
    return null;
  }
}

// --- CVM Client for Brain Communication ---
export async function sendPaymentConfirmation(
  status: 'paid' | 'rejected',
  reason: string,
  originalPaymentData: PendingPayment
) {
  console.log(`[CVM Client] Sending payment confirmation for refId: ${originalPaymentData.refId}`);
  const privateKey = getEnv('IDENTITY_CVM_PRIVATE_KEY', '');
  const brainPubKey = getEnv('BRAIN_CVM_PUBLIC_KEY', '').trim();
  if (!privateKey || privateKey.startsWith('YOUR_') || !brainPubKey || brainPubKey.startsWith('YOUR_')) {
    console.error('[CVM Client] FATAL: CVM keys for Identity (private) or Brain (public) are not set in .env.');
    return;
  }
  const signer = new PrivateKeySigner(privateKey);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const clientTransport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey: brainPubKey });
  const mcpClient = new McpClient({ name: "beacon-identity-client", version: "1.0.0" });
  try {
    await mcpClient.connect(clientTransport);
    console.log("[CVM Client] Connected to Brain CVM server.");
    const result = await mcpClient.callTool({
      name: originalPaymentData.responseTool,
      arguments: {
        status,
        reason,
        type: originalPaymentData.type === 'ln_address' ? 'payLnAddress' : 'payLnInvoice',
        data: originalPaymentData,
      },
    });
    console.log("[CVM Client] Brain responded to confirmation:", result);
  } catch (error) {
    console.error("[CVM Client] Failed to send payment confirmation to Brain:", error);
  } finally {
    await mcpClient.close();
    console.log("[CVM Client] Connection to Brain CVM server closed.");
  }
}

export async function notifyBrainOfNewUser(params: {
  gatewayType: string;
  gatewayId: string;
  npub: string;
}) {
  console.log(`[CVM Client] Notifying Brain of new user: ${params.npub}`);
  const privateKey = getEnv('IDENTITY_CVM_PRIVATE_KEY', '');
  const brainPubKey = getEnv('BRAIN_CVM_PUBLIC_KEY', '').trim();
  if (!privateKey || !brainPubKey) {
    console.error('[CVM Client] FATAL: CVM keys for Identity (private) or Brain (public) are not set in .env.');
    return;
  }

  const signer = new PrivateKeySigner(privateKey);
  const identityNpub = nip19.npubEncode(await signer.getPublicKey());
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const clientTransport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey: brainPubKey });
  const mcpClient = new McpClient({ name: "beacon-identity-client", version: "1.0.0" });

  try {
    await mcpClient.connect(clientTransport);
    console.log("[CVM Client] Connected to Brain CVM server for onboarding.");
    const result = await mcpClient.callTool({
      name: "onboardUser",
      arguments: {
        gatewayType: params.gatewayType,
        gatewayID: params.gatewayId,
        Npub: params.npub,
        beacon_id_npub: identityNpub,
      },
    });
    console.log("[CVM Client] Brain responded to onboardUser call:", result);
  } catch (error) {
    console.error("[CVM Client] Failed to notify Brain of new user:", error);
  } finally {
    await mcpClient.close();
    console.log("[CVM Client] Connection to Brain CVM server for onboarding closed.");
  }
}

// --- Main Server Logic ---
export async function startCvmServer() {
  console.log('[CVM] Identity CVM Server starting...');

  const privateKey = getEnv('IDENTITY_CVM_PRIVATE_KEY', '');
  if (!privateKey || privateKey.startsWith('YOUR_')) {
    console.error('[CVM] FATAL: IDENTITY_CVM_PRIVATE_KEY is not set in .env file.');
    process.exit(1);
  }

  const signer = new PrivateKeySigner(privateKey);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`[CVM] Identity Server Public Key: ${serverPubkey}`);
  console.log("[CVM] Connecting to relays...");

  const mcpServer = new McpServer({
    name: "Beacon Identity CVM Server",
    version: "1.0.0",
  });

  // --- Tool Definitions ---
  mcpServer.registerTool(
    "payLnAddress",
    {
      title: "Pay Lightning Address",
      description: "Initiates a payment to a Lightning Address",
      inputSchema: {
        npub: z.string(),
        refId: z.string(),
        lnAddress: z.string(),
        amount: z.number(),
        responsePubkey: z.string(),
        responseTool: z.string(),
      },
    },
    async (args) => {
      console.log(`[CVM] Received 'payLnAddress' request with refId: ${args.refId}`);
      if (isRefIdProcessed(args.refId)) {
        return { status: "error", details: "Duplicate request." };
      }

      // Prefer web gateway for approval; fall back to WhatsApp if no web mapping exists
      const webUser = findGatewayUserByNpubForType(args.npub, 'web');
      const waUser = findGatewayUserByNpubForType(args.npub, 'whatsapp') || findGatewayUserByNpub(args.npub);
      console.log(`[CVM] Mapping lookup for npub ${args.npub}: webUser=${webUser || 'none'}, waUser=${waUser || 'none'}`);
      const targetUser = webUser || waUser;
      const targetGateway: 'web' | 'whatsapp' | null = webUser ? 'web' : (waUser ? 'whatsapp' : null);
      if (targetUser && targetGateway) {
        console.log(`[CVM] Using ${targetGateway} for approval prompt to gatewayUser=${targetUser}`);
      }
      if (!targetUser || !targetGateway) {
        console.error(`[CVM] No gateway mapping found for user npub ${args.npub}. Cannot prompt for approval.`);
        return { status: "error", details: `User with npub ${args.npub} not found or not mapped to web/whatsapp.` };
      }

      // Idempotency guard
      markRefIdAsProcessed(args.refId);

      // Store pending and prompt for approval via the chosen gateway
      const pending: Omit<PendingPayment, 'createdAt'> = { type: 'ln_address', ...args };
      storePendingConfirmation(targetUser, pending);

      const amountStr = (args.amount != null) ? `${args.amount} sats` : 'an amount';
      const prompt = `Approve payment to Lightning Address '${args.lnAddress}' for ${amountStr}? Reply YES within 5 minutes to confirm.`;
      enqueueIdentityOut({
        to: targetUser,
        body: prompt,
        gateway: { type: targetGateway, npub: getEnv('GATEWAY_NPUB', '').trim() }
      });
      console.log(`[CVM] Enqueued approval prompt via ${targetGateway} to ${targetUser}`);

      // Optional auto-approval after BEACON_AUTO seconds
      const autoSecsRaw = (getEnv('BEACON_AUTO', '') || '').trim();
      const autoSecs = Number.parseInt(autoSecsRaw, 10);
      if (!Number.isNaN(autoSecs) && autoSecs > 0) {
        console.log(`[CVM] Auto-approval enabled: will auto-approve in ${autoSecs}s if no user reply`);
        setTimeout(async () => {
          try {
            // If the user already confirmed, this will return null (since worker consumed it)
            const stillPending = retrieveAndClearConfirmation(targetUser);
            if (!stillPending) {
              console.log('[CVM] Auto-approval skipped: no pending request (likely user approved)');
              return;
            }
            const result = await makePayment(stillPending);
            if (result.success) {
              enqueueIdentityOut({
                to: targetUser,
                body: `(Auto) Payment successful! Receipt: ${result.receipt}`,
                gateway: { type: targetGateway, npub: getEnv('GATEWAY_NPUB', '').trim() }
              });
              await sendPaymentConfirmation('paid', `Auto-approved payment. Receipt: ${result.receipt}`, stillPending);
              console.log('[CVM] Auto-approval completed: paid');
            } else {
              enqueueIdentityOut({
                to: targetUser,
                body: `(Auto) Payment failed: ${result.error}`,
                gateway: { type: targetGateway, npub: getEnv('GATEWAY_NPUB', '').trim() }
              });
              await sendPaymentConfirmation('rejected', result.error || 'Auto-approved payment failed', stillPending);
              console.log('[CVM] Auto-approval completed: rejected');
            }
          } catch (e) {
            console.error('[CVM] Auto-approval timer error:', e);
          }
        }, autoSecs * 1000);
      }

      return { status: "pending", details: `Awaiting user confirmation via ${targetGateway}.` };
    }
  );

  mcpServer.registerTool(
    "payLnInvoice",
    {
      title: "Pay Lightning Invoice",
      description: "Initiates a payment for a BOLT11 Lightning invoice",
      inputSchema: {
        npub: z.string(),
        refId: z.string(),
        lnInvoice: z.string(),
        responsePubkey: z.string(),
        responseTool: z.string(),
      },
    },
    async (args) => {
      console.log(`[CVM] Received 'payLnInvoice' request with refId: ${args.refId}`);
      
      // First, validate the invoice string itself.
      try {
        decode(args.lnInvoice);
      } catch (e: any) {
        console.error(`[CVM] Invalid invoice received: ${e.message}`);
        return { status: "error", details: `Invalid BOLT11 invoice provided: ${e.message}` };
      }

      if (isRefIdProcessed(args.refId)) {
        return { status: "error", details: "Duplicate request." };
      }

      const targetUser = findGatewayUserByNpubForType(args.npub, 'web') || findGatewayUserByNpub(args.npub);
      const targetGateway: 'web' | 'whatsapp' | null = findGatewayUserByNpubForType(args.npub, 'web') ? 'web' : (targetUser ? 'whatsapp' : null);

      if (!targetUser || !targetGateway) {
        console.error(`[CVM] No gateway mapping found for user npub ${args.npub}. Cannot prompt for approval.`);
        return { status: "error", details: `User with npub ${args.npub} not found or not mapped to web/whatsapp.` };
      }

      markRefIdAsProcessed(args.refId);

      const pending: Omit<PendingPayment, 'createdAt'> = { type: 'ln_invoice', ...args };
      storePendingConfirmation(targetUser, pending);

      const prompt = `Approve payment for Lightning invoice? Reply YES within 5 minutes to confirm.`;
      enqueueIdentityOut({
        to: targetUser,
        body: prompt,
        gateway: { type: targetGateway, npub: getEnv('GATEWAY_NPUB', '').trim() }
      });
      console.log(`[CVM] Enqueued approval prompt via ${targetGateway} to ${targetUser}`);

      return { status: "pending", details: `Awaiting user confirmation via ${targetGateway}.` };
    }
  );

  mcpServer.registerTool(
    "getBalance",
    {
      title: "Get Balance",
      description: "Fetches the current wallet balance in sats",
      inputSchema: {
        npub: z.string(),
        refId: z.string(),
      },
    },
    async (args) => {
      console.log(`[CVM] Received 'getBalance' request for npub: ${args.npub}`);
      
      // For now, we assume the shared wallet. In the future, this would look up the user's specific wallet.
      const result = await getBalance(args.npub);

      if (result.success) {
        return {
          status: "complete",
          npub: args.npub,
          balance: result.balance,
        };
      } else {
        return {
          status: "failed",
          npub: args.npub,
          error: result.error,
        };
      }
    }
  );

  mcpServer.registerTool(
    "getLNInvoice",
    {
      title: "Get Lightning Invoice",
      description: "Creates a new BOLT11 Lightning invoice for a specified amount",
      inputSchema: {
        npub: z.string(),
        refId: z.string(),
        amount: z.number(), // in sats
      },
    },
    async (args) => {
      console.log(`[CVM] Received 'getLNInvoice' request for ${args.amount} sats from npub: ${args.npub}`);
      
      const result = await createInvoice(args.npub, args.amount);

      if (result.success) {
        return {
          status: "complete",
          description: "Invoice created.",
          ln_Invoice: result.invoice,
          npub: args.npub,
          refId: args.refId,
          amount: args.amount,
        };
      } else {
        return {
          status: "error",
          description: result.error,
          npub: args.npub,
          refId: args.refId,
          amount: args.amount,
        };
      }
    }
  );

  mcpServer.registerTool(
    "getLNAddress",
    {
      title: "Get Lightning Address",
      description: "Fetches the user's Lightning Address",
      inputSchema: {
        npub: z.string(),
        refId: z.string(),
      },
    },
    async (args) => {
      console.log(`[CVM] Received 'getLNAddress' request from npub: ${args.npub}`);
      
      const result = await getLNAddress(args.npub);

      if (result.success) {
        return {
          status: "complete",
          description: "LN Address retrieved.",
          ln_address: result.lnAddress,
          npub: args.npub,
          refId: args.refId,
        };
      } else {
        return {
          status: "error",
          description: result.error,
          npub: args.npub,
          refId: args.refId,
        };
      }
    }
  );
  
  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    server: mcpServer.server,
  });

  await mcpServer.connect(serverTransport);
  console.log("[CVM] Server is running and listening for requests on Nostr...");
}
