import type { Connection} from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { BalanceInfo, Logger } from '../types';

/**
 * Token Balance Management
 *
 * Handles checking token balances and validating trading requirements.
 */

export interface BalanceConfig {
  minBtcBalance: number; // Minimum BTC to keep (never fully exit)
  minUsdcReserve: number; // Minimum USDC reserve (dry powder)
}

const mintDecimalsCache = new Map<string, number>();

async function getMintDecimals(
  connection: Connection,
  mintPublicKey: PublicKey,
  logger?: Logger
): Promise<number> {
  const mintStr = mintPublicKey.toBase58();
  const cached = mintDecimalsCache.get(mintStr);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const mintInfo = await getMint(connection, mintPublicKey, 'confirmed');
    mintDecimalsCache.set(mintStr, mintInfo.decimals);
    return mintInfo.decimals;
  } catch (error: any) {
    logger?.warn('Failed to fetch mint decimals, falling back to defaults', {
      mint: mintStr,
      error: error.message,
    });
    const fallbackDecimals = isBtcToken(mintStr) ? 8 : 6;
    mintDecimalsCache.set(mintStr, fallbackDecimals);
    return fallbackDecimals;
  }
}

/**
 * Get SPL token balance for a wallet
 */
export async function getTokenBalance(
  connection: Connection,
  walletPublicKey: PublicKey,
  mintPublicKey: PublicKey,
  logger?: Logger
): Promise<number> {
  try {
    // Get associated token account address
    const tokenAccountAddress = await getAssociatedTokenAddress(
      mintPublicKey,
      walletPublicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Get account info
    const tokenAccount = await getAccount(
      connection,
      tokenAccountAddress,
      'confirmed',
      TOKEN_PROGRAM_ID
    );

    // Convert to human-readable amount
    const decimals = await getMintDecimals(connection, mintPublicKey, logger);

    const balance = Number(tokenAccount.amount) / Math.pow(10, decimals);

    return balance;
  } catch (error: any) {
    // Token account doesn't exist yet (zero balance)
    if (error.message?.includes('could not find account')) {
      return 0;
    }

    logger?.error('Failed to get token balance:', {
      error: error.message,
      mint: mintPublicKey.toBase58(),
    });

    throw error;
  }
}

/**
 * Get all relevant balances for trading
 */
export async function getAllBalances(
  connection: Connection,
  walletPublicKey: PublicKey,
  usdcMint: string,
  cbBtcMint: string | undefined,
  wbtcMint: string,
  logger?: Logger
): Promise<{
  usdc: number;
  cbBtc: number;
  wbtc: number;
  totalBtc: number;
}> {
  try {
    logger?.info('Fetching token balances...');

    const [usdc, cbBtc, wbtc] = await Promise.all([
      getTokenBalance(connection, walletPublicKey, new PublicKey(usdcMint), logger),
      cbBtcMint
        ? getTokenBalance(connection, walletPublicKey, new PublicKey(cbBtcMint), logger)
        : Promise.resolve(0),
      getTokenBalance(connection, walletPublicKey, new PublicKey(wbtcMint), logger),
    ]);

    const totalBtc = cbBtc + wbtc;

    logger?.info('Balances fetched:', {
      usdc: usdc.toFixed(2),
      cbBtc: cbBtc.toFixed(8),
      wbtc: wbtc.toFixed(8),
      totalBtc: totalBtc.toFixed(8),
    });

    return { usdc, cbBtc, wbtc, totalBtc };
  } catch (error: any) {
    logger?.error('Failed to fetch balances:', error.message);
    throw error;
  }
}

/**
 * Check if wallet can execute a trade
 */
export async function canTrade(
  connection: Connection,
  walletPublicKey: PublicKey,
  usdcMint: string,
  cbBtcMint: string | undefined,
  wbtcMint: string,
  tradeSizeUsdc: number,
  config: BalanceConfig,
  logger?: Logger
): Promise<BalanceInfo> {
  try {
    const balances = await getAllBalances(
      connection,
      walletPublicKey,
      usdcMint,
      cbBtcMint,
      wbtcMint,
      logger
    );

    // Calculate required USDC (2 legs)
    const totalRequired = tradeSizeUsdc * 2;

    // Check USDC balance
    if (balances.usdc < totalRequired + config.minUsdcReserve) {
      const deficit = totalRequired + config.minUsdcReserve - balances.usdc;
      return {
        usdc: balances.usdc,
        btc: balances.totalBtc,
        canTrade: false,
        reason: `Insufficient USDC. Need ${totalRequired + config.minUsdcReserve} USDC, have ${balances.usdc.toFixed(2)} USDC (deficit: ${deficit.toFixed(2)})`,
      };
    }

    logger?.info('✓ Trade validation passed', {
      usdcAvailable: balances.usdc.toFixed(2),
      usdcRequired: totalRequired,
      usdcReserve: config.minUsdcReserve,
    });

    return {
      usdc: balances.usdc,
      btc: balances.totalBtc,
      canTrade: true,
    };
  } catch (error: any) {
    logger?.error('Trade validation failed:', error.message);
    return {
      usdc: 0,
      btc: 0,
      canTrade: false,
      reason: `Balance check error: ${error.message}`,
    };
  }
}

/**
 * Check if wallet can close a position
 */
export async function canClosePosition(
  connection: Connection,
  walletPublicKey: PublicKey,
  btcMint: string,
  requiredBtcAmount: number,
  config: BalanceConfig,
  logger?: Logger
): Promise<{ canClose: boolean; reason?: string }> {
  try {
    const btcBalance = await getTokenBalance(
      connection,
      walletPublicKey,
      new PublicKey(btcMint),
      logger
    );

    // Check if we have enough BTC to close (must keep minimum)
    const availableToSell = btcBalance - config.minBtcBalance;

    if (availableToSell < requiredBtcAmount) {
      return {
        canClose: false,
        reason: `Insufficient BTC. Need ${requiredBtcAmount.toFixed(8)}, have ${availableToSell.toFixed(8)} available (keeping ${config.minBtcBalance} minimum)`,
      };
    }

    return {
      canClose: true,
    };
  } catch (error: any) {
    logger?.error('Position close validation failed:', error.message);
    return {
      canClose: false,
      reason: `Balance check error: ${error.message}`,
    };
  }
}

/**
 * Check if mint is a BTC token
 */
function isBtcToken(mint: string): boolean {
  // cbBTC and WBTC both use 8 decimals
  const cbBTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
  const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

  return mint === cbBTC || mint === WBTC;
}

/**
 * Get human-readable balance summary
 */
export function getBalanceSummary(
  usdc: number,
  btc: number,
  btcPriceUsd: number
): string {
  const btcValue = btc * btcPriceUsd;
  const total = usdc + btcValue;

  return `
Balance Summary:
  USDC: $${usdc.toFixed(2)}
  BTC: ${btc.toFixed(8)} ($${btcValue.toFixed(2)} at $${btcPriceUsd.toFixed(2)}/BTC)
  Total: $${total.toFixed(2)}
  `.trim();
}
