// src/identity/wallet_manager.ts
// This module handles the actual Nostr Wallet Connect logic.

import type { PendingPayment } from './pending_store';
import { getEnv } from '../types';
import { WalletConnect } from 'applesauce-wallet-connect';
import { parseWalletConnectURI } from 'applesauce-wallet-connect/helpers';
import { getInvoice, parseLNURLOrAddress } from 'applesauce-core/helpers/lnurl';
import { RelayPool } from 'applesauce-relay';
import { hexToBytes } from '@noble/hashes/utils';
import { getDB } from '../db';
import { decrypt } from './encryption';

export interface PaymentResult {
  success: boolean;
  receipt?: string;
  error?: string;
}

// Per the nwcli example, the RelayPool should be persistent.
const pool = new RelayPool();

function getNwcUriForNpub(npub: string): string | null {
  const db = getDB();
  const row = db.query(`SELECT encrypted_nwc_string FROM user_wallets WHERE user_npub = ?`).get(npub) as any;
  if (!row) {
    // Fallback to shared wallet for testing or if user has no wallet
    return getEnv('SHARED_NWC_STRING', '');
  }
  return decrypt(row.encrypted_nwc_string);
}

/**
 * Makes a Lightning payment using Nostr Wallet Connect.
 */
export async function makePayment(details: PendingPayment): Promise<PaymentResult> {
  console.log(`[WalletManager] Processing payment for npub ${details.npub}:`, details);

  const nwcUri = getNwcUriForNpub(details.npub);
  if (!nwcUri) {
    return { success: false, error: `No wallet found for user ${details.npub}.` };
  }

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });

    let invoice: string;
    if (details.type === 'ln_address') {
      const lnurl = parseLNURLOrAddress(details.lnAddress);
      if (!lnurl) return { success: false, error: 'Invalid Lightning Address.' };
      const amountMsats = (details.amount || 0) * 1000;
      const callbackUrl = new URL(lnurl.toString());
      callbackUrl.searchParams.set('amount', String(amountMsats));
      const fetchedInvoice = await getInvoice(callbackUrl);
      if (!fetchedInvoice) return { success: false, error: 'Failed to fetch invoice from Lightning Address.' };
      invoice = fetchedInvoice;
    } else {
      invoice = details.lnInvoice;
    }

    const result = await client.payInvoice(invoice);
    if (result?.preimage) {
      return { success: true, receipt: result.preimage };
    } else {
      return { success: false, error: 'Payment was rejected or failed.' };
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'An unknown error occurred.' };
  }
}

export interface BalanceResult {
  success: boolean;
  balance?: number;
  error?: string;
}

/**
 * Fetches the balance from the NWC wallet for a given npub.
 */
export async function getBalance(npub: string): Promise<BalanceResult> {
  const nwcUri = getNwcUriForNpub(npub);
  if (!nwcUri) return { success: false, error: `No wallet found for user ${npub}.` };

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
    const result = await client.getBalance();
    const balanceSats = Math.floor(result.balance / 1000);
    return { success: true, balance: balanceSats };
  } catch (error: any) {
    return { success: false, error: error.message || 'An unknown error occurred.' };
  }
}

export interface InvoiceResult {
  success: boolean;
  invoice?: string;
  error?: string;
}

/**
 * Creates an invoice from the NWC wallet for a given npub.
 */
export async function createInvoice(npub: string, amountSats: number): Promise<InvoiceResult> {
  const nwcUri = getNwcUriForNpub(npub);
  if (!nwcUri) return { success: false, error: `No wallet found for user ${npub}.` };

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
    const result = await client.makeInvoice(amountSats * 1000, { description: 'Beacon Invoice' });
    if (result.invoice) {
      return { success: true, invoice: result.invoice };
    } else {
      return { success: false, error: 'Failed to create invoice.' };
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'An unknown error occurred.' };
  }
}

export interface LNAddressResult {
  success: boolean;
  lnAddress?: string;
  error?: string;
}

/**
 * Fetches the user's Lightning Address.
 */
export async function getLNAddress(npub: string): Promise<LNAddressResult> {
  const nwcUri = getNwcUriForNpub(npub);
  if (!nwcUri) return { success: false, error: `No wallet found for user ${npub}.` };

  try {
    const url = new URL(nwcUri.replace('nostr+walletconnect://', 'http://'));
    const lud16 = url.searchParams.get('lud16');
    if (lud16) {
      return { success: true, lnAddress: lud16 };
    } else {
      // Fallback to DB if not in NWC string
      const db = getDB();
      const row = db.query(`SELECT ln_address FROM user_wallets WHERE user_npub = ?`).get(npub) as any;
      if (row?.ln_address) {
        return { success: true, lnAddress: row.ln_address };
      }
      return { success: false, error: 'Lightning Address not found.' };
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'An unknown error occurred.' };
  }
}