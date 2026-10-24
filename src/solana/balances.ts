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
  /**
   * BTC-only sell floor, in BTC. Applies to cbBTC and WBTC and nothing else.
   *
   * It used to be subtracted before *every* sell regardless of the token held
   * (BUG-032). 0.001 is a sensible reserve in BTC and meaningless in JUP, so one
   * number cannot serve both: it made the guard far stricter for some assets than
   * others and the rejection then talked about "BTC" while discussing SOL.
   */
  minBtcBalance: number;
  /**
   * Optional per-asset sell floor, keyed by asset symbol (e.g. `{ SOL: 0.05 }`).
   * Takes precedence over `minBtcBalance`. An asset with no entry here, and that
   * is not BTC, keeps nothing back - which is safe under the hold/trade model:
   * a HOLD leg is never sold, so "never fully exit" is guaranteed by the model
   * rather than by a balance floor, and the balance-vs-quantity comparison still
   * refuses to sell more than the wallet holds.
   */
  minAssetBalance?: Record<string, number>;
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
 * Check if the wallet can trade a specific asset.
 *
 * `canTrade` below only ever looks at USDC + cbBTC + WBTC, so for a wETH/SOL/JUP
 * bot nothing verified the asset actually held (BUG-028). This checks USDC for the
 * buy and reports the target mint's own balance, with decimals resolved from the
 * chain rather than assumed.
 */
export async function canTradeAsset(
  connection: Connection,
  walletPublicKey: PublicKey,
  usdcMint: string,
  assetMint: string,
  tradeSizeUsdc: number,
  config: BalanceConfig,
  logger?: Logger
): Promise<{ canTrade: boolean; reason?: string; usdc: number; asset: number }> {
  try {
    const [usdc, asset] = await Promise.all([
      getTokenBalance(connection, walletPublicKey, new PublicKey(usdcMint), logger),
      getTokenBalance(connection, walletPublicKey, new PublicKey(assetMint), logger),
    ]);

    const totalRequired = tradeSizeUsdc * 2; // hold + trade leg
    const available = usdc - config.minUsdcReserve;

    if (available < totalRequired) {
      return {
        canTrade: false,
        reason: `Insufficient USDC. Need ${totalRequired.toFixed(2)}, have ${available.toFixed(2)} available (keeping ${config.minUsdcReserve} reserve)`,
        usdc,
        asset,
      };
    }

    return { canTrade: true, usdc, asset };
  } catch (error: any) {
    logger?.error('Asset trade validation failed:', error.message);
    return { canTrade: false, reason: `Balance check error: ${error.message}`, usdc: 0, asset: 0 };
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
 * How much of `mint` must stay in the wallet after a sell.
 *
 * An explicit per-asset floor wins; otherwise only BTC gets `minBtcBalance`,
 * because that number is denominated in BTC and means nothing in another token
 * (BUG-032). Everything else keeps nothing back - see `minAssetBalance`.
 */
function resolveSellReserve(
  mint: string,
  config: BalanceConfig,
  asset?: string
): number {
  const perAsset = asset ? config.minAssetBalance?.[asset] : undefined;
  if (perAsset !== undefined) return perAsset;
  return isBtcToken(mint) ? config.minBtcBalance : 0;
}

/**
 * Check if wallet can close a position.
 *
 * `asset` is the leg's symbol. It is optional only so existing callers keep
 * working; pass it, because it selects the per-asset floor and is what the
 * rejection message names.
 */
export async function canClosePosition(
  connection: Connection,
  walletPublicKey: PublicKey,
  mint: string,
  requiredAmount: number,
  config: BalanceConfig,
  logger?: Logger,
  asset?: string
): Promise<{ canClose: boolean; reason?: string }> {
  try {
    const balance = await getTokenBalance(
      connection,
      walletPublicKey,
      new PublicKey(mint),
      logger
    );

    // Keep back this asset's own floor, not a BTC-shaped one.
    const reserve = resolveSellReserve(mint, config, asset);
    const availableToSell = balance - reserve;
    const label = asset || mint;

    if (availableToSell < requiredAmount) {
      const keeping = reserve > 0 ? ` (keeping ${reserve} ${label} minimum)` : '';
      return {
        canClose: false,
        reason: `Insufficient ${label}. Need ${requiredAmount.toFixed(8)}, have ${availableToSell.toFixed(8)} available${keeping}`,
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
