import { Candle, MFIResult } from '../types';

/**
 * Money Flow Index (MFI) calculation
 *
 * MFI is a momentum indicator that uses price and volume to identify
 * overbought or oversold conditions. It's similar to RSI but incorporates volume.
 *
 * Formula:
 * 1. Typical Price = (High + Low + Close) / 3
 * 2. Raw Money Flow = Typical Price × Volume
 * 3. Money Flow Ratio = (14-period Positive Money Flow) / (14-period Negative Money Flow)
 * 4. MFI = 100 - (100 / (1 + Money Flow Ratio))
 *
 * Interpretation:
 * - MFI > 80: Overbought (potential sell signal)
 * - MFI < 20: Oversold (potential buy signal)
 * - Common thresholds: 30/70 for less aggressive entries
 */

/**
 * Calculate typical price for a candle
 * Typical Price = (High + Low + Close) / 3
 */
export function typicalPrice(candle: Candle): number {
  return (candle.high + candle.low + candle.close) / 3;
}

/**
 * Calculate MFI for the last candle in the provided array
 *
 * @param candles - Array of candles in chronological order (oldest → newest)
 * @param period - MFI period (typically 14)
 * @returns MFI value for the most recent candle
 *
 * @throws Error if insufficient candles (need at least period + 1)
 *
 * Note: Requires period + 1 candles because we need to compare
 * current typical price with previous typical price
 */
export function calculateMFI(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) {
    throw new Error(
      `MFI calculation requires at least ${period + 1} candles, got ${candles.length}`
    );
  }

  let positiveFlow = 0;
  let negativeFlow = 0;

  // Calculate money flow for the last 'period' candles
  // We compare each candle's TP with the previous candle's TP
  const end = candles.length - 1;
  const start = end - period + 1;

  for (let i = start; i <= end; i++) {
    const currentTP = typicalPrice(candles[i]);
    const previousTP = typicalPrice(candles[i - 1]);
    const rawMoneyFlow = candles[i].volume * currentTP;

    if (currentTP > previousTP) {
      positiveFlow += rawMoneyFlow;
    } else if (currentTP < previousTP) {
      negativeFlow += rawMoneyFlow;
    }
    // If equal, money flow is neither positive nor negative (ignored)
  }

  // Handle edge case: all negative flow
  if (negativeFlow === 0) {
    return 100; // Maximum overbought
  }

  // Calculate Money Flow Ratio and MFI
  const moneyFlowRatio = positiveFlow / negativeFlow;
  const mfi = 100 - (100 / (1 + moneyFlowRatio));

  return mfi;
}

/**
 * Calculate MFI with full metadata
 *
 * @param candles - Array of candles
 * @param period - MFI period (default 14)
 * @returns MFIResult with value and timestamp
 */
export function calculateMFIWithMetadata(
  candles: Candle[],
  period: number = 14
): MFIResult {
  const mfi = calculateMFI(candles, period);
  const latestCandle = candles[candles.length - 1];

  return {
    value: mfi,
    timestamp: latestCandle.timestamp,
  };
}

/**
 * Calculate MFI series for all candles
 * Returns an array where each element is the MFI for that candle
 *
 * @param candles - Array of candles
 * @param period - MFI period (default 14)
 * @returns Array of MFI values (null for candles before sufficient data)
 *
 * Example:
 * If period = 14 and you have 100 candles:
 * - Indices 0-13: null (insufficient data)
 * - Indices 14-99: MFI values
 */
export function calculateMFISeries(
  candles: Candle[],
  period: number = 14
): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);

  // Start at period (we need period + 1 candles, so index 'period' is the first valid)
  for (let i = period; i < candles.length; i++) {
    const window = candles.slice(0, i + 1); // From start to current candle
    result[i] = calculateMFI(window, period);
  }

  return result;
}

/**
 * Detect MFI crossover signals
 *
 * @param previousMFI - Previous candle's MFI value
 * @param currentMFI - Current candle's MFI value
 * @param buyLevel - Level for buy signal (default 30)
 * @param sellLevel - Level for sell signal (default 70)
 * @returns 'LONG' if crossing up from oversold, 'SHORT' if crossing down from overbought, 'NONE' otherwise
 */
export function detectMFICross(
  previousMFI: number,
  currentMFI: number,
  buyLevel: number = 30,
  sellLevel: number = 70
): 'LONG' | 'SHORT' | 'NONE' {
  // Buy signal: MFI crosses above buyLevel from below
  if (previousMFI < buyLevel && currentMFI >= buyLevel) {
    return 'LONG';
  }

  // Sell signal: MFI crosses below sellLevel from above
  if (previousMFI > sellLevel && currentMFI <= sellLevel) {
    return 'SHORT';
  }

  return 'NONE';
}
