/**
 * TDFI (Trend Direction & Force Index) Indicator
 *
 * Ported from MT4 "Trend Direction & Force Index - Smoothed 4.mq4"
 *
 * This indicator measures trend direction and force using:
 * - EMA-smoothed price (MMA)
 * - Second EMA smoothing (SMMA)
 * - Momentum calculation from both MMA and SMMA
 * - Normalization by highest absolute value
 * - Final smoothing with custom smoother
 *
 * Parameters:
 * - trendPeriod: Period for EMA calculation (default 20)
 * - triggerUp: Upper trigger level (default 0.05)
 * - triggerDown: Lower trigger level (default -0.05)
 * - smoothLength: Final smoothing length (default 5)
 *
 * Output:
 * - value: Normalized trend direction & force value (-1 to 1)
 *
 * Signal Logic:
 * - LONG: TDFI crosses above triggerUp
 * - SHORT: TDFI crosses below triggerDown
 */

import type { Candle, TDFIResult } from '../types';

/**
 * Custom iSmooth function from MT4 indicator
 * Uses 5-component smoothing
 */
function iSmooth(
  price: number,
  length: number,
  phase: number,
  state: number[]
): number {
  if (length < 1) return price;

  const alpha = 0.45 * (length - 1) / (0.45 * (length - 1) + 2);

  const s0 = price + alpha * (state[0] - price);
  const s1 = (price - s0) * (1 - alpha) + alpha * state[1];
  const s2 = s0 + s1;
  const s3 = (s2 - state[4]) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * state[3];
  const s4 = s3 + state[4];

  state[0] = s0;
  state[1] = s1;
  state[2] = s2;
  state[3] = s3;
  state[4] = s4;

  return s4;
}

/**
 * Find absolute highest value in array over lookback period
 */
function absHighest(values: number[], lookback: number, currentIndex: number): number {
  let maxAbs = 0;
  const start = Math.max(0, currentIndex - lookback + 1);

  for (let i = start; i <= currentIndex; i++) {
    const absVal = Math.abs(values[i]);
    if (absVal > maxAbs) {
      maxAbs = absVal;
    }
  }

  return maxAbs;
}

/**
 * Calculate TDFI for a series of candles
 *
 * @param candles - Array of candles in chronological order
 * @param trendPeriod - EMA period (default 20)
 * @param triggerUp - Upper trigger level (default 0.05)
 * @param triggerDown - Lower trigger level (default -0.05)
 * @param smoothLength - Final smoothing length (default 5)
 * @returns Array of TDFIResult for each candle
 */
export function calculateTDFISeries(
  candles: Candle[],
  trendPeriod: number = 20,
  triggerUp: number = 0.05,
  triggerDown: number = -0.05,
  smoothLength: number = 5
): TDFIResult[] {
  if (candles.length < trendPeriod * 3 + 10) {
    return [];
  }

  const results: TDFIResult[] = [];
  const alpha = 2.0 / (trendPeriod + 1.0);

  // Working arrays
  const mma: number[] = [];     // Primary EMA
  const smma: number[] = [];    // Secondary EMA
  const tdf: number[] = [];     // Raw TDF values

  // iSmooth state
  const smoothState: number[] = [0, 0, 0, 0, 0];

  // First pass: calculate MMA, SMMA, and raw TDF
  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;

    // Initialize first value
    if (i === 0) {
      mma.push(price);
      smma.push(price);
      tdf.push(0);
      continue;
    }

    // Calculate MMA (EMA of price)
    const currentMMA = mma[i - 1] + alpha * (price - mma[i - 1]);
    mma.push(currentMMA);

    // Calculate SMMA (EMA of MMA)
    const currentSMMA = smma[i - 1] + alpha * (currentMMA - smma[i - 1]);
    smma.push(currentSMMA);

    // Calculate impulse from MMA and SMMA
    const impetMMA = currentMMA - mma[i - 1];
    const impetSMMA = currentSMMA - smma[i - 1];

    // Calculate divergence between MMA and SMMA
    const epsilon = 0.00001;
    const divMA = Math.abs(currentMMA - currentSMMA) / epsilon;
    const averImpet = (impetMMA + impetSMMA) / (2 * epsilon);

    // Calculate raw TDF value
    const rawTDF = divMA * Math.pow(averImpet, 3);
    tdf.push(rawTDF);
  }

  // Second pass: normalize and smooth
  for (let i = trendPeriod * 3; i < candles.length; i++) {
    // Find absolute highest TDF over lookback period
    const absValue = absHighest(tdf, trendPeriod * 3, i);

    // Normalize
    let normalizedTDF = 0;
    if (absValue > 0) {
      normalizedTDF = tdf[i] / absValue;
    }

    // Apply iSmooth
    const smoothedTDF = iSmooth(normalizedTDF, smoothLength, 0, smoothState);

    // Clamp to -1 to 1
    const clampedTDF = Math.max(-1, Math.min(1, smoothedTDF));

    results.push({
      value: clampedTDF,
      timestamp: candles[i].timestamp,
    });
  }

  return results;
}

/**
 * Get TDFI signal based on trigger level crossover
 *
 * @param previous - Previous TDFI result
 * @param current - Current TDFI result
 * @param triggerUp - Upper trigger level (default 0.05)
 * @param triggerDown - Lower trigger level (default -0.05)
 * @returns Signal type and trend
 */
export function getTDFISignal(
  previous: TDFIResult,
  current: TDFIResult,
  triggerUp: number = 0.05,
  triggerDown: number = -0.05
): { signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let trend: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  // Crossover signals based on trigger levels
  if (previous.value < triggerUp && current.value >= triggerUp) {
    signal = 'LONG';
  } else if (previous.value > triggerDown && current.value <= triggerDown) {
    signal = 'SHORT';
  }

  // Current trend
  if (current.value > triggerUp) {
    trend = 'LONG';
  } else if (current.value < triggerDown) {
    trend = 'SHORT';
  }

  return { signal, trend };
}

/**
 * Calculate TDFI for the most recent candle and return signal
 * Convenience function for bot usage
 */
export function calculateTDFIWithSignal(
  candles: Candle[],
  trendPeriod: number = 20,
  triggerUp: number = 0.05,
  triggerDown: number = -0.05,
  smoothLength: number = 5
): { result: TDFIResult | null; signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  const series = calculateTDFISeries(candles, trendPeriod, triggerUp, triggerDown, smoothLength);

  if (series.length < 2) {
    return { result: null, signal: 'NONE', trend: 'NONE' };
  }

  const previous = series[series.length - 2];
  const current = series[series.length - 1];
  const { signal, trend } = getTDFISignal(previous, current, triggerUp, triggerDown);

  return { result: current, signal, trend };
}
