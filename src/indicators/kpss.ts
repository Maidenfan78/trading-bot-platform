/**
 * Kase Permission Stochastic Smoothed (KPSS) Indicator
 *
 * Ported from MT4 kase-permission-stochastic-smoothed.mq4
 *
 * This indicator is a smoothed stochastic with:
 * - Triple smoothing using EMA
 * - Custom lookback period calculation (pstLength * pstX)
 * - Additional iSmooth smoothing function
 *
 * Parameters:
 * - pstLength: Stochastic length (default 8)
 * - pstX: Multiplier for lookback (default 4)
 * - pstSmooth: EMA smoothing period (default 3)
 * - smoothPeriod: Final smoothing period (default 11)
 *
 * Outputs:
 * - stochastic: Main stochastic line
 * - signal: Signal line
 *
 * Signal Logic:
 * - LONG: stochastic crosses above signal
 * - SHORT: stochastic crosses below signal
 */

import type { Candle, KPSSResult } from '../types';

/**
 * Simple Moving Average helper
 */
function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

/**
 * iSmooth function - custom smoothing from MT4 indicator
 * Uses a 5-component smoothing algorithm
 */
function iSmooth(
  price: number,
  length: number,
  state: number[]
): number {
  if (length < 1) return price;

  const alpha = 0.45 * (length - 1) / (0.45 * (length - 1) + 2);

  const s0 = price + alpha * (state[0] - price);
  const s1 = (price - s0) * (1 - alpha) + alpha * state[1];
  const s2 = s0 + s1;
  const s3 = (s2 - state[4]) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * state[3];
  const s4 = s3 + state[4];

  // Update state for next iteration
  state[0] = s0;
  state[1] = s1;
  state[2] = s2;
  state[3] = s3;
  state[4] = s4;

  return s4;
}

/**
 * Calculate KPSS for a series of candles
 *
 * @param candles - Array of candles in chronological order
 * @param pstLength - Stochastic length (default 8)
 * @param pstX - Lookback multiplier (default 4)
 * @param pstSmooth - EMA smoothing period (default 3)
 * @param smoothPeriod - Final smoothing period (default 11)
 * @returns Array of KPSSResult for each candle
 */
export function calculateKPSSSeries(
  candles: Candle[],
  pstLength: number = 8,
  pstX: number = 4,
  pstSmooth: number = 3,
  smoothPeriod: number = 11
): KPSSResult[] {
  const lookBackPeriod = pstLength * pstX;

  if (candles.length < lookBackPeriod + 10) {
    return [];
  }

  const results: KPSSResult[] = [];
  const alpha = 2 / (1 + pstSmooth);

  // Working buffers
  const tripleK: number[] = [];
  const tripleDF: number[] = [];
  const tripleDS: number[] = [];
  const tripleDFs: number[] = [];
  const tripleDSs: number[] = [];

  // iSmooth states (5 components each for 2 instances)
  const smoothState0: number[] = [0, 0, 0, 0, 0];
  const smoothState1: number[] = [0, 0, 0, 0, 0];

  for (let i = 0; i < candles.length; i++) {
    // Find min/max over lookback period
    let min = candles[i].low;
    let max = candles[i].high;

    for (let j = 1; j < lookBackPeriod && (i - j) >= 0; j++) {
      min = Math.min(min, candles[i - j].low);
      max = Math.max(max, candles[i - j].high);
    }

    // Calculate raw stochastic K
    const range = max - min;
    const k = range > 0 ? 100 * (candles[i].close - min) / range : 0;
    tripleK.push(k);

    // Skip first few bars for initialization
    if (i < pstX) {
      tripleDF.push(k);
      tripleDS.push(k);
      tripleDFs.push(k);
      tripleDSs.push(k);
      continue;
    }

    // TripleDF: EMA smoothing with pstX lag
    const prevDF = tripleDF[tripleDF.length - pstX] || k;
    const df = prevDF + alpha * (k - prevDF);
    tripleDF.push(df);

    // TripleDS: Weighted average with pstX lag
    const prevDS = tripleDS[tripleDS.length - pstX] || k;
    const ds = (prevDS * 2 + df) / 3;
    tripleDS.push(ds);

    // SMA of TripleDS over 3 periods
    const dsSma = sma(tripleDS, 3);
    tripleDSs.push(dsSma);

    // SMA of TripleDF over 3 periods
    const dfSma = sma(tripleDF, 3);
    tripleDFs.push(dfSma);

    // Apply iSmooth
    const signal = iSmooth(dsSma, smoothPeriod, smoothState0);
    const stochastic = iSmooth(dfSma, smoothPeriod, smoothState1);

    // Only add results after sufficient warmup
    if (i >= lookBackPeriod) {
      results.push({
        value: Math.max(0, Math.min(100, stochastic)),
        signal: Math.max(0, Math.min(100, signal)),
        timestamp: candles[i].timestamp,
      });
    }
  }

  return results;
}

/**
 * Get KPSS signal based on line crossover
 *
 * @param previous - Previous KPSS result
 * @param current - Current KPSS result
 * @returns Signal type and trend
 */
export function getKPSSSignal(
  previous: KPSSResult,
  current: KPSSResult
): { signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let trend: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  // Line cross signal (value vs signal)
  if (previous.value < previous.signal && current.value >= current.signal) {
    signal = 'LONG';
  } else if (previous.value > previous.signal && current.value <= current.signal) {
    signal = 'SHORT';
  }

  // Current trend
  if (current.value > current.signal) {
    trend = 'LONG';
  } else if (current.value < current.signal) {
    trend = 'SHORT';
  }

  return { signal, trend };
}

/**
 * Calculate KPSS for the most recent candle and return signal
 * Convenience function for bot usage
 */
export function calculateKPSSWithSignal(
  candles: Candle[],
  pstLength: number = 8,
  pstX: number = 4,
  pstSmooth: number = 3,
  smoothPeriod: number = 11
): { result: KPSSResult | null; signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  const series = calculateKPSSSeries(candles, pstLength, pstX, pstSmooth, smoothPeriod);

  if (series.length < 2) {
    return { result: null, signal: 'NONE', trend: 'NONE' };
  }

  const previous = series[series.length - 2];
  const current = series[series.length - 1];
  const { signal, trend } = getKPSSSignal(previous, current);

  return { result: current, signal, trend };
}
