// src/identity/wallet_manager.ts
// This module handles the actual Nostr Wallet Connect logic.

import type { PendingPayment } from './pending_store';
import { getEnv } from '../types';
import { WalletConnect } from 'applesauce-wallet-connect';
import { parseWalletConnectURI } from 'applesauce-wallet-connect/helpers';
import { getInvoice, parseLNURLOrAddress } from 'applesauce-core/helpers/lnurl';
import { RelayPool } from 'applesauce-relay';
import { hexToBytes } from '@noble/hashes/utils';

export interface PaymentResult {
  success: boolean;
  receipt?: string;
  error?: string;
}

// Per the nwcli example, the RelayPool should be persistent.
// It is created once and should only be closed when the application exits.
const pool = new RelayPool();

/**
 * Makes a Lightning payment using Nostr Wallet Connect.
 * Handles both direct invoices and Lightning Addresses (via LNURL).
 * @param details The details of the payment to be made.
 * @returns A promise that resolves with the payment result.
 */
export async function makePayment(details: PendingPayment): Promise<PaymentResult> {
  console.log(`[WalletManager] Processing payment for ${details.type}:`, details);

  const nwcUri = getEnv('SHARED_NWC_STRING', '');
  if (!nwcUri) {
    console.error('[WalletManager] FATAL: SHARED_NWC_STRING is not set in .env.');
    return { success: false, error: 'Wallet connection is not configured.' };
  }

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);

    const client = new WalletConnect({
      ...parsedUri,
      secret,
      subscriptionMethod: pool.subscription.bind(pool),
      publishMethod: pool.publish.bind(pool),
    });

    console.log('[WalletManager] NWC client initialized.');

    let invoice: string;

    if (details.type === 'ln_address') {
      if (!details.lnAddress || !details.amount) {
        return { success: false, error: 'Missing Lightning Address or amount.' };
      }
      console.log(`[WalletManager] Fetching invoice for LN Address: ${details.lnAddress}`);
      
      const lnurl = parseLNURLOrAddress(details.lnAddress);
      if (!lnurl) {
        return { success: false, error: 'Invalid Lightning Address.' };
      }

      const amountMsats = details.amount * 1000;
      const callbackUrl = new URL(lnurl.toString());
      callbackUrl.searchParams.set('amount', String(amountMsats));

      const fetchedInvoice = await getInvoice(callbackUrl);
      if (!fetchedInvoice) {
        return { success: false, error: 'Failed to fetch invoice from Lightning Address.' };
      }
      invoice = fetchedInvoice;
      console.log(`[WalletManager] Fetched invoice: ${invoice.substring(0, 30)}...`);
    } else if (details.type === 'ln_invoice') {
      if (!details.lnInvoice) {
        return { success: false, error: 'Missing Lightning Invoice.' };
      }
      invoice = details.lnInvoice;
    } else {
      return { success: false, error: 'Unsupported payment type.' };
    }

    console.log('[WalletManager] Sending payment request to wallet...');
    const result = await client.payInvoice(invoice);

    if (result && result.preimage) {
      console.log(`[WalletManager] Payment successful. Preimage: ${result.preimage}`);
      return {
        success: true,
        receipt: result.preimage,
      };
    } else {
      console.error('[WalletManager] Payment failed.', result);
      return {
        success: false,
        error: 'Payment was rejected or failed.',
      };
    }
  } catch (error: any) {
    console.error('[WalletManager] An error occurred:', error);
    return {
      success: false,
      error: error.message || 'An unknown error occurred during payment.',
    };
  }
  // NOTE: We no longer close the relay pool here. It persists for the life of the application.
}

export interface BalanceResult {
  success: boolean;
  balance?: number; // in sats
  error?: string;
}

/**
 * Fetches the balance from the NWC wallet.
 * @returns A promise that resolves with the balance result.
 */
export async function getBalance(): Promise<BalanceResult> {
  console.log('[WalletManager] Fetching balance...');

  const nwcUri = getEnv('SHARED_NWC_STRING', '');
  if (!nwcUri) {
    console.error('[WalletManager] FATAL: SHARED_NWC_STRING is not set in .env.');
    return { success: false, error: 'Wallet connection is not configured.' };
  }

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);

    const client = new WalletConnect({
      ...parsedUri,
      secret,
      subscriptionMethod: pool.subscription.bind(pool),
      publishMethod: pool.publish.bind(pool),
    });

    const result = await client.getBalance();
    const balanceSats = Math.floor(result.balance / 1000);
    console.log(`[WalletManager] Balance received: ${balanceSats} sats`);

    return {
      success: true,
      balance: balanceSats,
    };
  } catch (error: any) {
    console.error('[WalletManager] An error occurred while fetching balance:', error);
    return {
      success: false,
      error: error.message || 'An unknown error occurred while fetching balance.',
    };
  }
}

export interface InvoiceResult {
  success: boolean;
  invoice?: string;
  error?: string;
}

/**
 * Creates an invoice from the NWC wallet.
 * @param amountSats The amount for the invoice in sats.
 * @returns A promise that resolves with the invoice result.
 */
export async function createInvoice(amountSats: number): Promise<InvoiceResult> {
  console.log(`[WalletManager] Creating invoice for ${amountSats} sats...`);

  const nwcUri = getEnv('SHARED_NWC_STRING', '');
  if (!nwcUri) {
    console.error('[WalletManager] FATAL: SHARED_NWC_STRING is not set in .env.');
    return { success: false, error: 'Wallet connection is not configured.' };
  }

  try {
    const parsedUri = parseWalletConnectURI(nwcUri);
    const secret = hexToBytes(parsedUri.secret);

    const client = new WalletConnect({
      ...parsedUri,
      secret,
      subscriptionMethod: pool.subscription.bind(pool),
      publishMethod: pool.publish.bind(pool),
    });

    const amountMsats = amountSats * 1000;
    const result = await client.makeInvoice(amountMsats, { description: 'Beacon Invoice' });

    if (result.invoice) {
      console.log(`[WalletManager] Invoice created: ${result.invoice.substring(0, 30)}...`);
      return {
        success: true,
        invoice: result.invoice,
      };
    } else {
      console.error('[WalletManager] Invoice creation failed.', result);
      return { success: false, error: 'Failed to create invoice.' };
    }
  } catch (error: any) {
    console.error('[WalletManager] An error occurred while creating invoice:', error);
    return {
      success: false,
      error: error.message || 'An unknown error occurred while creating invoice.',
    };
  }
}

export interface LNAddressResult {
  success: boolean;
  lnAddress?: string;
  error?: string;
}

/**
 * Fetches the user's Lightning Address.
 * NOTE: This is a placeholder. NWC does not have a standard method for this.
 * This implementation returns a hardcoded value for testing.
 * @returns A promise that resolves with the Lightning Address result.
 */
export async function getLNAddress(): Promise<LNAddressResult> {
  console.log('[WalletManager] Fetching Lightning Address...');
  
  const nwcUri = getEnv('SHARED_NWC_STRING', '');
  if (!nwcUri) {
    console.error('[WalletManager] FATAL: SHARED_NWC_STRING is not set in .env.');
    return { success: false, error: 'Wallet connection is not configured.' };
  }

  try {
    // HACK: This is a non-standard way to get the LN address.
    // It relies on the `lud16` parameter being present in the NWC URI, which services like Alby provide.
    // This will not work for all NWC connections (e.g., a local LNBits wallet).
    // A robust solution would require provider-specific logic.
    const url = new URL(nwcUri.replace('nostr+walletconnect://', 'http://'));
    const lud16 = url.searchParams.get('lud16');

    if (lud16) {
      console.log(`[WalletManager] Found LN Address in NWC string: ${lud16}`);
      return {
        success: true,
        lnAddress: lud16,
      };
    } else {
      return {
        success: false,
        error: 'Lightning Address (lud16) not found in the NWC connection string.',
      };
    }
  } catch (error: any) {
    console.error('[WalletManager] An error occurred while parsing LN Address:', error);
    return {
      success: false,
      error: error.message || 'An unknown error occurred while parsing the NWC string.',
    };
  }
}
