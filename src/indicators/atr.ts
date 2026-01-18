import { Candle, ATRResult } from '../types';

/**
 * Average True Range (ATR) Calculation
 *
 * ATR measures market volatility by calculating the average of true ranges
 * over a specified period. It's used for:
 * - Setting stop-loss distances (trailing stops)
 * - Setting take-profit targets
 * - Position sizing based on volatility
 *
 * True Range (TR) is the greatest of:
 * 1. Current High - Current Low
 * 2. Abs(Current High - Previous Close)
 * 3. Abs(Current Low - Previous Close)
 *
 * ATR = Simple Moving Average of TR over N periods
 */

/**
 * Calculate True Range for a single candle
 *
 * @param current - Current candle
 * @param previous - Previous candle (needed for gap calculations)
 * @returns True Range value
 */
export function calculateTrueRange(current: Candle, previous: Candle): number {
  const highLow = current.high - current.low;
  const highClose = Math.abs(current.high - previous.close);
  const lowClose = Math.abs(current.low - previous.close);

  return Math.max(highLow, highClose, lowClose);
}

/**
 * Calculate ATR for the last candle in the provided array
 *
 * Uses Simple Moving Average (SMA) method for ATR calculation.
 * This is the classic Wilder's ATR implementation using SMA instead of EMA
 * for simplicity and consistency.
 *
 * @param candles - Array of candles in chronological order (oldest → newest)
 * @param period - ATR period (typically 14)
 * @returns ATR value for the most recent candle
 *
 * @throws Error if insufficient candles (need at least period + 1)
 *
 * Note: Requires period + 1 candles because we need previous close
 * to calculate the first true range
 */
export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) {
    throw new Error(
      `ATR calculation requires at least ${period + 1} candles, got ${candles.length}`
    );
  }

  // Calculate true ranges for the last 'period' candles
  const trueRanges: number[] = [];
  const end = candles.length - 1;
  const start = end - period + 1;

  for (let i = start; i <= end; i++) {
    const tr = calculateTrueRange(candles[i], candles[i - 1]);
    trueRanges.push(tr);
  }

  // Calculate average (SMA)
  const sum = trueRanges.reduce((acc, tr) => acc + tr, 0);
  const atr = sum / period;

  return atr;
}

/**
 * Calculate ATR with full metadata
 *
 * @param candles - Array of candles
 * @param period - ATR period (default 14)
 * @returns ATRResult with value and timestamp
 */
export function calculateATRWithMetadata(
  candles: Candle[],
  period: number = 14
): ATRResult {
  const atr = calculateATR(candles, period);
  const latestCandle = candles[candles.length - 1];

  return {
    value: atr,
    timestamp: latestCandle.timestamp,
  };
}

/**
 * Calculate ATR series for all candles
 * Returns an array where each element is the ATR for that candle
 *
 * @param candles - Array of candles
 * @param period - ATR period (default 14)
 * @returns Array of ATR values (null for candles before sufficient data)
 *
 * Example:
 * If period = 14 and you have 100 candles:
 * - Indices 0-13: null (insufficient data)
 * - Indices 14-99: ATR values
 */
export function calculateATRSeries(
  candles: Candle[],
  period: number = 14
): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);

  // Start at period (we need period + 1 candles)
  for (let i = period; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    result[i] = calculateATR(window, period);
  }

  return result;
}

/**
 * Calculate stop-loss and take-profit levels based on ATR
 *
 * @param entryPrice - Entry price for the position
 * @param atr - Current ATR value
 * @param tpMultiplier - TP target as multiple of ATR (default 1.0)
 * @param stopMultiplier - Stop distance as multiple of ATR (default 2.5)
 * @returns Object with TP and initial stop levels
 */
export function calculateATRLevels(
  entryPrice: number,
  atr: number,
  tpMultiplier: number = 1.0,
  stopMultiplier: number = 2.5
): {
  takeProfitPrice: number;
  initialStopPrice: number;
  atrDistance: number;
} {
  const tpDistance = atr * tpMultiplier;
  const stopDistance = atr * stopMultiplier;

  return {
    takeProfitPrice: entryPrice + tpDistance, // For long positions
    initialStopPrice: entryPrice - stopDistance, // For long positions
    atrDistance: atr,
  };
}

/**
 * Update trailing stop based on ATR
 *
 * @param highestPrice - Highest price reached since entry
 * @param currentStop - Current stop price
 * @param atr - Current ATR value
 * @param multiplier - ATR multiplier for trailing distance (default 2.5)
 * @returns New stop price (only moves up, never down)
 */
export function updateTrailingStop(
  highestPrice: number,
  currentStop: number,
  atr: number,
  multiplier: number = 2.5
): number {
  const newStop = highestPrice - atr * multiplier;

  // Trailing stop only moves in favor of the trade (up for long)
  return Math.max(newStop, currentStop);
}

/**
 * Check if ATR is within reasonable bounds (sanity check)
 *
 * @param atr - ATR value to validate
 * @param price - Current price for context
 * @returns true if ATR is reasonable
 *
 * Checks:
 * - ATR is positive
 * - ATR is not absurdly large (> 50% of price suggests data error)
 * - ATR is not absurdly small (< 0.01% of price suggests dead market)
 */
export function isValidATR(atr: number, price: number): boolean {
  if (atr <= 0) {
    return false;
  }

  const atrPercentage = (atr / price) * 100;

  // ATR should be between 0.01% and 50% of price
  if (atrPercentage < 0.01 || atrPercentage > 50) {
    return false;
  }

  return true;
}
