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
): Promise<{ signature: string; success: boolean; error?: string }> {
  const maxRetries = options?.maxRetries ?? 3;
  const skipPreflight = options?.skipPreflight ?? false;
  const commitment = options?.commitment ?? 'confirmed';

  logger?.info('Sending versioned transaction...', {
    skipPreflight,
    commitment,
    maxRetries,
  });

  let lastError: string = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Sign transaction
      transaction.sign([wallet]);

      // Send transaction
      const sendOptions: SendOptions = {
        skipPreflight,
        maxRetries: 0, // We handle retries ourselves
        preflightCommitment: commitment,
      };

      const signature = await connection.sendTransaction(transaction, sendOptions);

      logger?.info(`Transaction sent (attempt ${attempt}/${maxRetries}):`, {
        signature,
      });

      // Confirm transaction
      const confirmation = await connection.confirmTransaction(signature, commitment);

      if (confirmation.value.err) {
        lastError = `Transaction failed: ${JSON.stringify(confirmation.value.err)}`;
        logger?.error(lastError);

        if (attempt < maxRetries) {
          logger?.info(`Retrying... (${attempt}/${maxRetries})`);
          await sleep(2000 * attempt); // Exponential backoff
          continue;
        }
      } else {
        logger?.info('✓ Transaction confirmed:', { signature });
        return { signature, success: true };
      }
    } catch (error: any) {
      lastError = error.message;
      logger?.error(`Transaction attempt ${attempt} failed:`, lastError);

      if (attempt < maxRetries) {
        logger?.info(`Retrying... (${attempt}/${maxRetries})`);
        await sleep(2000 * attempt);
        continue;
      }
    }
  }

  return {
    signature: '',
    success: false,
    error: lastError || 'Transaction failed after max retries',
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
