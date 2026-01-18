import { Signal, SignalType } from '../types';

/**
 * MFI Cross Signal Detection
 *
 * This bot uses MFI crossover levels to generate entry and trim signals:
 *
 * LONG Signal (Entry):
 * - Previous MFI < buyLevel (default 30)
 * - Current MFI >= buyLevel
 * - Interpretation: Market moving from oversold to neutral (potential bounce)
 *
 * SHORT Signal (Trim/Reduce):
 * - Previous MFI > sellLevel (default 70)
 * - Current MFI <= sellLevel
 * - Interpretation: Market moving from overbought to neutral (take profits)
 * - Note: We don't short on DEX, this is a "reduce exposure" signal
 *
 * NONE Signal:
 * - No crossover detected
 */

/**
 * Detect MFI crossover signal
 *
 * @param previousMFI - MFI value from previous candle
 * @param currentMFI - MFI value from current candle
 * @param buyLevel - MFI level for long signal (default 30)
 * @param sellLevel - MFI level for short/trim signal (default 70)
 * @returns SignalType: 'LONG', 'SHORT', or 'NONE'
 */
export function detectMFICrossSignal(
  previousMFI: number,
  currentMFI: number,
  buyLevel: number = 30,
  sellLevel: number = 70
): SignalType {
  // Long signal: MFI crosses UP through buyLevel
  if (previousMFI < buyLevel && currentMFI >= buyLevel) {
    return 'LONG';
  }

  // Short/Trim signal: MFI crosses DOWN through sellLevel
  if (previousMFI > sellLevel && currentMFI <= sellLevel) {
    return 'SHORT';
  }

  // No signal
  return 'NONE';
}

/**
 * Generate full signal with metadata
 *
 * @param previousMFI - Previous MFI value
 * @param currentMFI - Current MFI value
 * @param currentPrice - Current BTC price
 * @param currentATR - Current ATR value
 * @param timestamp - Timestamp of current candle
 * @param buyLevel - MFI buy level (default 30)
 * @param sellLevel - MFI sell level (default 70)
 * @returns Signal object with full context
 */
export function generateSignal(
  previousMFI: number,
  currentMFI: number,
  currentPrice: number,
  currentATR: number,
  timestamp: number,
  buyLevel: number = 30,
  sellLevel: number = 70
): Signal {
  const type = detectMFICrossSignal(previousMFI, currentMFI, buyLevel, sellLevel);

  return {
    type,
    timestamp,
    mfi: currentMFI,
    atr: currentATR,
    price: currentPrice,
  };
}

/**
 * Validate signal conditions (for safety checks)
 *
 * @param signal - Signal to validate
 * @returns true if signal is valid and safe to act on
 */
export function isValidSignal(signal: Signal): boolean {
  // Basic validation
  if (signal.type === 'NONE') {
    return false;
  }

  // Ensure MFI is in valid range
  if (signal.mfi < 0 || signal.mfi > 100) {
    return false;
  }

  // Ensure ATR is positive
  if (signal.atr <= 0) {
    return false;
  }

  // Ensure price is positive
  if (signal.price <= 0) {
    return false;
  }

  return true;
}
