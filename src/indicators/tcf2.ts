/**
 * Trend Continuation Factor 2 (TCF2) Indicator
 *
 * Ported from MT4 TrendContinuation2.mq4
 *
 * This indicator measures trend continuation strength using:
 * - Price change accumulation (positive and negative)
 * - T3 smoothing for noise reduction
 *
 * Parameters:
 * - n: Period for change accumulation (default 14)
 * - t3Period: T3 smoothing period (default 5)
 * - b: T3 smoothing factor (default 0.618 - golden ratio)
 *
 * Outputs:
 * - line1 (green): Smoothed positive momentum
 * - line2 (red): Smoothed negative momentum
 *
 * Signal Logic:
 * - LONG: line1 crosses above line2
 * - SHORT: line1 crosses below line2
 * - Trend: line1 > line2 = Long trend, line1 < line2 = Short trend
 */

import type { Candle, TCF2Result } from '../types';

export interface TCF2State {
  // T3 smoothing state for line1
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  e5: number;
  e6: number;
  // T3 smoothing state for line2
  e12: number;
  e22: number;
  e32: number;
  e42: number;
  e52: number;
  e62: number;
  // Change tracking arrays
  changeP: number[];
  changeN: number[];
  cfP: number[];
  cfN: number[];
}

/**
 * Initialize TCF2 state
 */
export function initTCF2State(): TCF2State {
  return {
    e1: 0, e2: 0, e3: 0, e4: 0, e5: 0, e6: 0,
    e12: 0, e22: 0, e32: 0, e42: 0, e52: 0, e62: 0,
    changeP: [],
    changeN: [],
    cfP: [],
    cfN: [],
  };
}

/**
 * Calculate TCF2 for a series of candles
 *
 * @param candles - Array of candles in chronological order
 * @param n - Period for change accumulation (default 14)
 * @param t3Period - T3 smoothing period (default 5)
 * @param b - T3 smoothing factor (default 0.618)
 * @returns Array of TCF2Result for each candle
 */
export function calculateTCF2Series(
  candles: Candle[],
  n: number = 14,
  t3Period: number = 5,
  b: number = 0.618
): TCF2Result[] {
  if (candles.length < n + 1) {
    return [];
  }

  const results: TCF2Result[] = [];

  // T3 coefficients
  const b2 = b * b;
  const b3 = b2 * b;
  const c1 = -b3;
  const c2 = 3 * (b2 + b3);
  const c3 = -3 * (2 * b2 + b + b3);
  const c4 = 1 + 3 * b + b3 + 3 * b2;

  // T3 smoothing weights
  let n1 = t3Period;
  if (n1 < 1) n1 = 1;
  n1 = 1 + 0.5 * (n1 - 1);
  const w1 = 2 / (n1 + 1);
  const w2 = 1 - w1;

  // State variables
  let e1 = 0, e2 = 0, e3 = 0, e4 = 0, e5 = 0, e6 = 0;
  let e12 = 0, e22 = 0, e32 = 0, e42 = 0, e52 = 0, e62 = 0;

  // Change tracking arrays
  const changeP: number[] = new Array(candles.length).fill(0);
  const changeN: number[] = new Array(candles.length).fill(0);
  const cfP: number[] = new Array(candles.length).fill(0);
  const cfN: number[] = new Array(candles.length).fill(0);

  // First pass: calculate changes and cumulative flows
  for (let i = 1; i < candles.length; i++) {
    const currentClose = candles[i].close;
    const previousClose = candles[i - 1].close;

    if (currentClose > previousClose) {
      changeP[i] = currentClose - previousClose;
      cfP[i] = changeP[i] + cfP[i - 1];
      changeN[i] = 0;
      cfN[i] = 0;
    } else {
      changeP[i] = 0;
      cfP[i] = 0;
      changeN[i] = previousClose - currentClose;
      cfN[i] = changeN[i] + cfN[i - 1];
    }
  }

  // Second pass: calculate TCF2 values with T3 smoothing
  for (let i = n; i < candles.length; i++) {
    // Sum over period
    let chP = 0, chN = 0, cffP = 0, cffN = 0;
    for (let j = i - n; j <= i; j++) {
      chP += changeP[j];
      chN += changeN[j];
      cffP += cfP[j];
      cffN += cfN[j];
    }

    // Calculate k values
    const kP = chP - cffN;
    const kN = chN - cffP;

    // T3 smoothing for line1 (positive momentum)
    const A1 = kP;
    e1 = w1 * A1 + w2 * e1;
    e2 = w1 * e1 + w2 * e2;
    e3 = w1 * e2 + w2 * e3;
    e4 = w1 * e3 + w2 * e4;
    e5 = w1 * e4 + w2 * e5;
    e6 = w1 * e5 + w2 * e6;
    const t3_1 = c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3;

    // T3 smoothing for line2 (negative momentum)
    const A2 = kN;
    e12 = w1 * A2 + w2 * e12;
    e22 = w1 * e12 + w2 * e22;
    e32 = w1 * e22 + w2 * e32;
    e42 = w1 * e32 + w2 * e42;
    e52 = w1 * e42 + w2 * e52;
    e62 = w1 * e52 + w2 * e62;
    const t3_2 = c1 * e62 + c2 * e52 + c3 * e42 + c4 * e32;

    results.push({
      line1: t3_1,
      line2: t3_2,
      timestamp: candles[i].timestamp,
    });
  }

  return results;
}

/**
 * Get TCF2 signal based on line crossover
 *
 * @param previous - Previous TCF2 result
 * @param current - Current TCF2 result
 * @returns Signal type and trend
 */
export function getTCF2Signal(
  previous: TCF2Result,
  current: TCF2Result
): { signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let trend: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  // Line cross signal
  if (previous.line1 < previous.line2 && current.line1 >= current.line2) {
    signal = 'LONG';
  } else if (previous.line1 > previous.line2 && current.line1 <= current.line2) {
    signal = 'SHORT';
  }

  // Current trend
  if (current.line1 > current.line2) {
    trend = 'LONG';
  } else if (current.line1 < current.line2) {
    trend = 'SHORT';
  }

  return { signal, trend };
}

/**
 * Calculate TCF2 for the most recent candle and return signal
 * Convenience function for bot usage
 */
export function calculateTCF2WithSignal(
  candles: Candle[],
  n: number = 14,
  t3Period: number = 5,
  b: number = 0.618
): { result: TCF2Result | null; signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  const series = calculateTCF2Series(candles, n, t3Period, b);

  if (series.length < 2) {
    return { result: null, signal: 'NONE', trend: 'NONE' };
  }

  const previous = series[series.length - 2];
  const current = series[series.length - 1];
  const { signal, trend } = getTCF2Signal(previous, current);

  return { result: current, signal, trend };
}
