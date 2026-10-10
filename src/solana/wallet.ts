import type {
  Connection,
  SendOptions,
  VersionedTransaction} from '@solana/web3.js';
import {
  Keypair,
  PublicKey,
  ConfirmOptions,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Logger } from '../types';

/**
 * Solana Transaction Utilities
 *
 * Handles wallet management, transaction signing, sending, and confirmation
 * with retries and proper error handling.
 */

/**
 * Load wallet from base58 secret key
 */
export function loadWallet(secretKey: string, logger?: Logger): Keypair {
  try {
    const secretKeyBytes = bs58.decode(secretKey);
    const keypair = Keypair.fromSecretKey(secretKeyBytes);

    logger?.info('Wallet loaded successfully:', {
      publicKey: keypair.publicKey.toBase58(),
    });

    return keypair;
  } catch (error: any) {
    logger?.error('Failed to load wallet:', error.message);
    throw new Error(`Invalid wallet secret key: ${error.message}`);
  }
}

/**
 * Send and confirm versioned transaction with retries
 */
/**
 * Outcome of sending a transaction.
 *
 * `unresolved` is the important one: it means we sent a transaction and could
 * NOT determine whether it landed. That is not the same as failure, and
 * treating it as failure is what caused BUG-030 - an orphaned buy where the
 * wallet spent USDC and held coins while the bot recorded no position, so no
 * take-profit could ever fire, nothing reached the accumulation ledger, and the
 * free slot invited a second buy.
 */
export interface SendTransactionResult {
  /** Always populated once anything was sent, even on failure. */
  signature: string;
  success: boolean;
  /** Sent, but its fate is unknown. Requires reconciliation, not a retry. */
  unresolved?: boolean;
  error?: string;
}

/**
 * Ask the chain what actually happened to a signature.
 *
 * `searchTransactionHistory` matters: by default the RPC only knows recent
 * signatures held in cache, and a confirmation timeout is exactly the case
 * where the status has aged out of it.
 */
async function resolveSignatureFate(
  connection: Connection,
  signature: string,
  logger?: Logger
): Promise<'confirmed' | 'failed' | 'unknown'> {
  try {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    const value = status?.value;
    if (!value) return 'unknown';
    if (value.err) {
      logger?.error('Transaction landed but failed on-chain:', {
        signature,
        err: JSON.stringify(value.err),
      });
      return 'failed';
    }
    if (
      value.confirmationStatus === 'confirmed' ||
      value.confirmationStatus === 'finalized' ||
      (typeof value.confirmations === 'number' && value.confirmations > 0) ||
      value.confirmations === null // null means finalized (rooted)
    ) {
      return 'confirmed';
    }
    return 'unknown';
  } catch (error: any) {
    logger?.warn('Could not query signature status:', {
      signature,
      error: error.message,
    });
    return 'unknown';
  }
}

export async function sendAndConfirmVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  wallet: Keypair,
  options?: {
    maxRetries?: number;
    skipPreflight?: boolean;
    commitment?: 'processed' | 'confirmed' | 'finalized';
  },
  logger?: Logger
): Promise<SendTransactionResult> {
  const maxRetries = options?.maxRetries ?? 3;
  const skipPreflight = options?.skipPreflight ?? false;
  const commitment = options?.commitment ?? 'confirmed';

  logger?.info('Sending versioned transaction...', {
    skipPreflight,
    commitment,
    maxRetries,
  });

  let lastError = '';
  // Retained across attempts so a failure can still report WHAT was sent.
  // Returning an empty signature is what made an orphaned buy uninvestigable.
  let lastSignature = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Re-signing the same message yields the same signature, so a resend is
      // idempotent: Solana rejects the duplicate rather than executing twice.
      // That is why this loop cannot double-buy.
      transaction.sign([wallet]);

      const sendOptions: SendOptions = {
        skipPreflight,
        maxRetries: 0, // We handle retries ourselves
        preflightCommitment: commitment,
      };

      const signature = await connection.sendTransaction(transaction, sendOptions);
      lastSignature = signature;

      logger?.info(`Transaction sent (attempt ${attempt}/${maxRetries}):`, {
        signature,
      });

      const confirmation = await connection.confirmTransaction(signature, commitment);

      if (confirmation.value.err) {
        // Definitive: it executed and failed, so nothing moved (Solana applies
        // a transaction atomically). Resending the identical signature cannot
        // succeed, so retrying here only wastes the blockhash window.
        lastError = `Transaction failed: ${JSON.stringify(confirmation.value.err)}`;
        logger?.error(lastError, { signature });
        return { signature, success: false, error: lastError };
      }

      logger?.info('✓ Transaction confirmed:', { signature });
      return { signature, success: true };
    } catch (error: any) {
      lastError = error.message;
      logger?.error(`Transaction attempt ${attempt} failed:`, lastError);

      // A throw from confirmTransaction is usually a TIMEOUT, which does not
      // mean the transaction failed - it routinely means "landed, but the RPC
      // stopped waiting". Ask the chain before deciding anything.
      if (lastSignature) {
        const fate = await resolveSignatureFate(connection, lastSignature, logger);
        if (fate === 'confirmed') {
          logger?.info(
            '✓ Confirmation timed out, but the transaction DID land - treating as success.',
            { signature: lastSignature }
          );
          return { signature: lastSignature, success: true };
        }
        if (fate === 'failed') {
          return {
            signature: lastSignature,
            success: false,
            error: `Transaction landed but failed on-chain: ${lastError}`,
          };
        }
        // 'unknown' - fall through and retry; the resend is idempotent.
      }

      if (attempt < maxRetries) {
        logger?.info(`Retrying... (${attempt}/${maxRetries})`);
        await sleep(2000 * attempt);
        continue;
      }
    }
  }

  // Out of attempts. If we ever got a signature out the door, its fate is
  // unknown rather than known-bad, and the caller MUST treat that as needing
  // reconciliation: the wallet may hold coins this process never recorded.
  if (lastSignature) {
    const fate = await resolveSignatureFate(connection, lastSignature, logger);
    if (fate === 'confirmed') {
      logger?.info('✓ Late confirmation found for the last signature - treating as success.', {
        signature: lastSignature,
      });
      return { signature: lastSignature, success: true };
    }
    if (fate === 'unknown') {
      logger?.error(
        'UNRESOLVED TRANSACTION - sent but its fate is unknown. The wallet may hold ' +
          'coins that were never recorded. Reconcile against the wallet before trading ' +
          'this asset again.',
        { signature: lastSignature, explorer: `https://solscan.io/tx/${lastSignature}` }
      );
      return {
        signature: lastSignature,
        success: false,
        unresolved: true,
        error: lastError || 'Confirmation never resolved',
      };
    }
  }

  return {
    signature: lastSignature,
    success: false,
    error: lastError,
  };
}

/**
 * Simulate transaction before sending (dry run)
 */
export async function simulateVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  wallet: Keypair,
  logger?: Logger
): Promise<{ success: boolean; logs?: string[]; error?: string }> {
  try {
    logger?.info('Simulating transaction...');

    // Sign transaction for simulation
    transaction.sign([wallet]);

    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      logger?.error('Simulation failed:', simulation.value.err);
      return {
        success: false,
        error: JSON.stringify(simulation.value.err),
        logs: simulation.value.logs || undefined,
      };
    }

    logger?.info('✓ Simulation successful', {
      computeUnits: simulation.value.unitsConsumed,
    });

    return {
      success: true,
      logs: simulation.value.logs || undefined,
    };
  } catch (error: any) {
    logger?.error('Simulation error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get recent blockhash with retry
 */
export async function getRecentBlockhash(
  connection: Connection,
  maxRetries: number = 3,
  logger?: Logger
): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      return { blockhash, lastValidBlockHeight };
    } catch (error: any) {
      logger?.error(`Failed to get blockhash (attempt ${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        await sleep(1000 * attempt);
        continue;
      }
    }
  }

  return null;
}

/**
 * Check if RPC is healthy
 */
export async function checkRPCHealth(connection: Connection, logger?: Logger): Promise<boolean> {
  try {
    const slot = await connection.getSlot();
    logger?.info('RPC health check passed:', { slot });
    return true;
  } catch (error: any) {
    logger?.error('RPC health check failed:', error.message);
    return false;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse transaction error for better error messages
 */
export function parseTransactionError(error: any): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error?.message) {
    return error.message;
  }

  if (error?.err) {
    return JSON.stringify(error.err);
  }

  return 'Unknown transaction error';
}
