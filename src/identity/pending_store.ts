// src/identity/pending_store.ts

// This interface defines the structure of the payment details we need to store
// while awaiting 2FA confirmation from the user.
export interface PendingPayment {
  type: 'ln_address' | 'ln_invoice';
  npub: string;
  refId: string;
  lnAddress?: string;
  lnInvoice?: string;
  amount?: number;
  responsePubkey: string;
  responseTool: string;
  createdAt: number;
}

// A simple in-memory Map to store pending confirmations.
// The key is the user's WhatsApp JID (e.g., '1234567890@c.us').
const pendingConfirmations = new Map<string, PendingPayment>();

const TIMEOUT_SECONDS = 5 * 60; // 5 minutes

/**
 * Stores the details of a payment awaiting user confirmation.
 * @param userJid The user's WhatsApp ID.
 * @param paymentDetails The details of the payment from the CVM tool call.
 */
export function storePendingConfirmation(userJid: string, paymentDetails: Omit<PendingPayment, 'createdAt'>): void {
  const fullDetails: PendingPayment = {
    ...paymentDetails,
    createdAt: Date.now(),
  };
  pendingConfirmations.set(userJid, fullDetails);
  console.log(`[PendingStore] Stored pending payment for ${userJid}. Awaiting confirmation.`);
}

/**
 * Retrieves and removes a pending payment confirmation for a user.
 * This is a one-time-get operation. Once retrieved, it's removed to prevent replay attacks.
 * It also checks for expiry.
 * @param userJid The user's WhatsApp ID.
 * @returns The pending payment details, or null if not found or expired.
 */
export function retrieveAndClearConfirmation(userJid: string): PendingPayment | null {
  const payment = pendingConfirmations.get(userJid);

  if (!payment) {
    return null;
  }

  // It's a one-time operation, so we remove it immediately.
  pendingConfirmations.delete(userJid);

  // Check for timeout
  const ageInSeconds = (Date.now() - payment.createdAt) / 1000;
  if (ageInSeconds > TIMEOUT_SECONDS) {
    console.log(`[PendingStore] Pending payment for ${userJid} has expired.`);
    return null;
  }

  console.log(`[PendingStore] Retrieved pending payment for ${userJid}.`);
  return payment;
}

// A background process to periodically clean up expired confirmations
// that were never replied to. This prevents memory leaks.
setInterval(() => {
  const now = Date.now();
  for (const [userJid, payment] of pendingConfirmations.entries()) {
    const ageInSeconds = (now - payment.createdAt) / 1000;
    if (ageInSeconds > TIMEOUT_SECONDS) {
      pendingConfirmations.delete(userJid);
      console.log(`[PendingStore] Cleaned up expired payment for ${userJid}`);
    }
  }
}, 60 * 1000); // Check every minute
