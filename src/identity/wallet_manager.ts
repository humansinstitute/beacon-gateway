// src/identity/wallet_manager.ts
// This module handles the actual Nostr Wallet Connect logic.

import type { PendingPayment } from './pending_store';
import { getEnv } from '../types';
import { WalletConnect } from 'applesauce-wallet-connect';
import { parseWalletConnectURI } from 'applesauce-wallet-connect/helpers';
import { RelayPool } from 'applesauce-relay';
import { hexToBytes } from '@noble/hashes/utils';
import { getDB } from '../db';
import { decrypt } from './encryption';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';

export interface PaymentResult {
  success: boolean;
  receipt?: string;
  error?: string;
}

const pool = new RelayPool();

function getNwcUriForNpub(npub: string): string | null {
  const db = getDB();
  const row = db.query(`SELECT encrypted_nwc_string FROM user_wallets WHERE user_npub = ?`).get(npub) as any;
  if (!row) return getEnv('SHARED_NWC_STRING', '');
  return decrypt(row.encrypted_nwc_string);
}

// --- LNURL Helper Functions (modeled on nwcli) ---

async function getInvoiceFromLnAddress(lnAddress: string, amountSats: number): Promise<string> {
  console.log(`[LNURL] Getting invoice for ${lnAddress}`);
  
  const [name, domain] = lnAddress.split('@');
  if (!name || !domain) throw new Error('Invalid Lightning Address format.');
  const lnurlpUrl = new URL(`https://${domain}/.well-known/lnurlp/${name}`);
  
  console.log(`[LNURL] Fetching params from ${lnurlpUrl.toString()}`);
  const paramsRes = await fetch(lnurlpUrl.toString());
  const params = await paramsRes.json();
  if (params.status === 'ERROR' || params.tag !== 'payRequest') {
    throw new Error(`LNURL-pay failed: ${params.reason || 'Invalid response'}`);
  }

  const amountMsats = amountSats * 1000;
  const callbackUrl = new URL(params.callback);
  callbackUrl.searchParams.set('amount', String(amountMsats));
  
  console.log(`[LNURL] Requesting invoice from ${callbackUrl.toString()}`);
  const invoiceRes = await fetch(callbackUrl.toString());
  const invoiceData = await invoiceRes.json();
  if (invoiceData.status === 'ERROR' || !invoiceData.pr) {
    throw new Error(`Failed to get invoice: ${invoiceData.reason || 'Invalid response'}`);
  }
  
  const invoice = invoiceData.pr;
  const decoded = decodeBolt11(invoice);
  const invoiceAmountMsats = decoded.sections.find(s => s.name === 'amount')?.value;
  if (String(invoiceAmountMsats) !== String(amountMsats)) {
    throw new Error(`Invoice amount mismatch. Expected ${amountMsats}, got ${invoiceAmountMsats}`);
  }
  
  console.log(`[LNURL] Successfully fetched and verified invoice.`);
  return invoice;
}


/**
 * Makes a Lightning payment using Nostr Wallet Connect.
 */
export async function makePayment(details: PendingPayment): Promise<PaymentResult> {
  console.log(`[WalletManager] Processing payment for npub ${details.npub}:`, details);

  const nwcUri = getNwcUriForNpub(details.npub);
  if (!nwcUri) return { success: false, error: `No wallet found for user ${details.npub}.` };

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });

    let invoice: string;
    if (details.type === 'ln_address') {
      if (!details.lnAddress || !details.amount) return { success: false, error: 'Missing lnAddress or amount' };
      invoice = await getInvoiceFromLnAddress(details.lnAddress, details.amount);
    } else {
      invoice = details.lnInvoice!;
    }

    const result = await client.payInvoice(invoice);
    if (result?.preimage) {
      return { success: true, receipt: result.preimage };
    } else {
      return { success: false, error: 'Payment was rejected or failed.' };
    }
  } catch (error: any) {
    console.error('[WalletManager] makePayment failed:', error);
    return { success: false, error: error.message || 'An unknown error occurred.' };
  }
}

export interface BalanceResult {
  success: boolean;
  balance?: number;
  error?: string;
}
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
export async function getLNAddress(npub: string): Promise<LNAddressResult> {
  const nwcUri = getNwcUriForNpub(npub);
  if (!nwcUri) return { success: false, error: `No wallet found for user ${npub}.` };
  try {
    const url = new URL(nwcUri.replace('nostr+walletconnect://', 'http://'));
    const lud16 = url.searchParams.get('lud16');
    if (lud16) {
      return { success: true, lnAddress: lud16 };
    } else {
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
export async function validateNwcString(nwcUri: string): Promise<boolean> {
  console.log(`[WalletManager] Validating NWC URI...`);
  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);
    const client = new WalletConnect({ ...parsedUri, secret, subscriptionMethod: pool.subscription.bind(pool), publishMethod: pool.publish.bind(pool) });
    await client.getBalance();
    console.log(`[WalletManager] NWC URI is valid.`);
    return true;
  } catch (error) {
    console.error('[WalletManager] NWC URI validation failed:', error);
    return false;
  }
}