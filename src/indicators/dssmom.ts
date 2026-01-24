/**
 * DSS-MOM (DSS Averages of Momentum) Indicator
 *
 * Ported from MT4 "dss-averages-of-momentum.mq4"
 *
 * This indicator applies Double Stochastic Smoothing to momentum:
 * 1. Calculate momentum (close - close[momPeriod])
 * 2. Apply DSS (Double Stochastic Smoothing) to momentum
 * 3. Create a signal line using EMA of DSS
 *
 * Parameters:
 * - stochasticLength: Period for stochastic lookback (default 32)
 * - smoothMA: Smoothing period (default 15)
 * - signalMA: Signal line period (default 3)
 * - momPeriod: Momentum period (default 14)
 *
 * Output:
 * - dss: Main DSS line (0-100 range)
 * - signal: Signal line (0-100 range)
 *
 * Signal Logic:
 * - LONG: dss crosses above signal
 * - SHORT: dss crosses below signal
 */

import type { Candle, DSSMOMResult } from '../types';

/**
 * EMA calculation helper
 */
function calculateEMA(
  value: number,
  period: number,
  prevEma: number
): number {
  const alpha = 2.0 / (1.0 + period);
  return prevEma + alpha * (value - prevEma);
}

/**
 * Calculate DSS-MOM for a series of candles
 *
 * @param candles - Array of candles in chronological order
 * @param stochasticLength - Period for stochastic lookback (default 32)
 * @param smoothMA - Smoothing period (default 15)
 * @param signalMA - Signal line period (default 3)
 * @param momPeriod - Momentum period (default 14)
 * @returns Array of DSSMOMResult for each candle
 */
export function calculateDSSMOMSeries(
  candles: Candle[],
  stochasticLength: number = 32,
  smoothMA: number = 15,
  signalMA: number = 3,
  momPeriod: number = 14
): DSSMOMResult[] {
  const minBars = Math.max(momPeriod, stochasticLength) + smoothMA * 2 + 10;
  if (candles.length < minBars) {
    return [];
  }

  const results: DSSMOMResult[] = [];

  // Working arrays for DSS calculation
  const momHighHistory: number[] = [];
  const momLowHistory: number[] = [];
  const ss1History: number[] = [];
  const dssHistory: number[] = [];
  const stoch2History: number[] = [];

  // Process each candle
  for (let i = 0; i < candles.length; i++) {
    // Need momPeriod bars for momentum calculation
    if (i < momPeriod) {
      continue;
    }

    // Calculate momentum (current - previous)
    const momClose = candles[i].close - candles[i - momPeriod].close;
    const momHigh = candles[i].high - candles[i - momPeriod].high;
    const momLow = candles[i].low - candles[i - momPeriod].low;

    // Add to history (most recent first)
    momHighHistory.unshift(momHigh);
    momLowHistory.unshift(momLow);

    // Keep only stochasticLength items in history
    if (momHighHistory.length > stochasticLength) {
      momHighHistory.pop();
      momLowHistory.pop();
    }

    // Not enough history for stochastic
    if (momHighHistory.length < 2) {
      continue;
    }

    // Find min/max of momentum over lookback period
    let momMin = momLow;
    let momMax = momHigh;

    for (let k = 0; k < momHighHistory.length; k++) {
      momMin = Math.min(momMin, momLowHistory[k]);
      momMax = Math.max(momMax, momHighHistory[k]);
    }

    // Calculate raw stochastic of momentum
    let st1 = 0;
    if (momMax !== momMin) {
      st1 = 100 * (momClose - momMin) / (momMax - momMin);
    }

    // Smooth the raw stochastic (EMA)
    let ss1: number;
    if (ss1History.length === 0) {
      ss1 = st1;
    } else {
      ss1 = calculateEMA(st1, smoothMA, ss1History[0]);
    }

    ss1History.unshift(ss1);
    if (ss1History.length > stochasticLength) {
      ss1History.pop();
    }

    // Not enough ss1 history for second stochastic
    if (ss1History.length < 2) {
      continue;
    }

    // Find min/max of ss1 over lookback period
    let ss1Min = ss1;
    let ss1Max = ss1;

    for (let k = 0; k < ss1History.length; k++) {
      ss1Min = Math.min(ss1Min, ss1History[k]);
      ss1Max = Math.max(ss1Max, ss1History[k]);
    }

    // Calculate second stochastic
    let stoch2 = 0;
    if (ss1Max !== ss1Min) {
      stoch2 = 100 * (ss1 - ss1Min) / (ss1Max - ss1Min);
    }

    stoch2History.unshift(stoch2);
    if (stoch2History.length > smoothMA) {
      stoch2History.pop();
    }

    // Final smoothing (EMA) to get DSS
    let dss: number;
    if (dssHistory.length === 0) {
      dss = stoch2;
    } else {
      dss = calculateEMA(stoch2, smoothMA, dssHistory[0]);
    }

    // Clamp to 0-100
    dss = Math.max(0, Math.min(100, dss));

    dssHistory.unshift(dss);
    if (dssHistory.length > signalMA + 5) {
      dssHistory.pop();
    }

    // Need enough DSS history for signal calculation
    if (dssHistory.length < 2) {
      continue;
    }

    // Calculate signal line (EMA of DSS)
    let signal: number;
    if (dssHistory.length < signalMA) {
      // Simple average for warmup
      signal = dssHistory.reduce((a, b) => a + b, 0) / dssHistory.length;
    } else {
      // EMA calculation
      signal = dssHistory[dssHistory.length - 1]; // Start from oldest
      for (let k = dssHistory.length - 2; k >= 0; k--) {
        signal = calculateEMA(dssHistory[k], signalMA, signal);
      }
    }

    results.push({
      dss,
      signal,
      timestamp: candles[i].timestamp,
    });
  }

  return results;
}

/**
 * Get DSS-MOM signal based on line crossover
 *
 * @param previous - Previous DSS-MOM result
 * @param current - Current DSS-MOM result
 * @returns Signal type and trend
 */
export function getDSSMOMSignal(
  previous: DSSMOMResult,
  current: DSSMOMResult
): { signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  let signal: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let trend: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  // Crossover signals (dss crosses signal line)
  if (previous.dss < previous.signal && current.dss >= current.signal) {
    signal = 'LONG';
  } else if (previous.dss > previous.signal && current.dss <= current.signal) {
    signal = 'SHORT';
  }

  // Current trend
  if (current.dss > current.signal) {
    trend = 'LONG';
  } else if (current.dss < current.signal) {
    trend = 'SHORT';
  }

  return { signal, trend };
}

/**
 * Calculate DSS-MOM for the most recent candle and return signal
 * Convenience function for bot usage
 */
export function calculateDSSMOMWithSignal(
  candles: Candle[],
  stochasticLength: number = 32,
  smoothMA: number = 15,
  signalMA: number = 3,
  momPeriod: number = 14
): { result: DSSMOMResult | null; signal: 'LONG' | 'SHORT' | 'NONE'; trend: 'LONG' | 'SHORT' | 'NONE' } {
  const series = calculateDSSMOMSeries(candles, stochasticLength, smoothMA, signalMA, momPeriod);

  if (series.length < 2) {
    return { result: null, signal: 'NONE', trend: 'NONE' };
  }

  const previous = series[series.length - 2];
  const current = series[series.length - 1];
  const { signal, trend } = getDSSMOMSignal(previous, current);

  return { result: current, signal, trend };
}
