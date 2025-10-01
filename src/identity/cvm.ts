// src/identity/cvm.ts
// This module manages the ContextVM server and client for the Identity service.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import { ApplesauceRelayPool, NostrServerTransport, NostrClientTransport, PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";
import { getEnv } from "../types";
import { PendingPayment } from "./pending_store";
import { enqueueIdentityOut } from "./queues";
import { getDB } from "../db";
import { makePayment } from "./wallet_manager";

// --- Configuration ---
const RELAYS = ["wss://relay.contextvm.org", "wss://cvm.otherstuff.ai"];

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

// --- DB Helper ---
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
      
      const userJid = findGatewayUserByNpub(args.npub);
      if (!userJid) {
        return { status: "error", details: `User with npub ${args.npub} not found or not mapped.` };
      }
      
      markRefIdAsProcessed(args.refId);

      // --- TEMPORARY: AUTO-CONFIRMATION FOR TESTING ---
      console.log(`[CVM] AUTO-CONFIRMING payment for ${userJid} for testing.`);
      
      const paymentDetails: PendingPayment = { type: 'ln_address', ...args, createdAt: Date.now() };
      const result = await makePayment(paymentDetails);

      if (result.success) {
        const confirmationText = `(Auto-Confirmed) Payment successful! Receipt: ${result.receipt}`;
        enqueueIdentityOut({
          to: userJid,
          body: confirmationText,
          gateway: { type: 'whatsapp', npub: getEnv('GATEWAY_NPUB', '').trim() }
        });
        await sendPaymentConfirmation('paid', `Successful payment. Receipt: ${result.receipt}`, paymentDetails);
        return { status: "paid", details: `Auto-confirmed and processed. Receipt: ${result.receipt}` };
      } else {
        const failureText = `(Auto-Confirmed) Payment failed: ${result.error}`;
        enqueueIdentityOut({
          to: userJid,
          body: failureText,
          gateway: { type: 'whatsapp', npub: getEnv('GATEWAY_NPUB', '').trim() }
        });
        await sendPaymentConfirmation('rejected', result.error || 'Payment failed', paymentDetails);
        return { status: "rejected", details: `Auto-confirmed and failed. Reason: ${result.error}` };
      }
      // --- END OF TEMPORARY CODE ---
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
