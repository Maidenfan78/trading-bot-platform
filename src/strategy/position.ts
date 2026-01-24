import type { PositionLeg, LegType, Signal, Logger } from '../types';
import { calculateATRLevels, updateTrailingStop } from '../indicators/atr';

/**
 * Position Management - Two-Leg Model
 *
 * This module manages the two-leg position structure:
 * - Leg 1 (TP): Fixed take-profit at +1×ATR
 * - Leg 2 (Runner): Trailing stop at 2.5×ATR from highest price
 *
 * Each LONG signal opens TWO positions with different exit strategies.
 */

/**
 * Generate unique position leg ID
 */
function generateLegId(type: LegType, timestamp: number): string {
  return `${type}_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate shared position ID for a two-leg position
 */
function generatePositionId(timestamp: number): string {
  return `POS_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create two-leg position from a LONG signal
 *
 * @param signal - LONG signal with entry price and ATR
 * @param usdcAmount - USDC amount per leg (default $100)
 * @param tpMultiplier - ATR multiplier for TP (default 1.0)
 * @param trailMultiplier - ATR multiplier for trailing stop (default 2.5)
 * @param logger - Optional logger instance
 * @returns Array of two PositionLeg objects
 */
export function createTwoLegPosition(
  signal: Signal,
  usdcAmount: number = 100,
  tpMultiplier: number = 1.0,
  trailMultiplier: number = 2.5,
  logger?: Logger
): PositionLeg[] {
  if (signal.type !== 'LONG') {
    throw new Error('Can only create positions from LONG signals');
  }

  const entryPrice = signal.price;
  const atr = signal.atr;
  const timestamp = signal.timestamp;
  const positionId = generatePositionId(timestamp);

  // Calculate levels
  const levels = calculateATRLevels(entryPrice, atr, tpMultiplier, trailMultiplier);

  // Calculate quantities (assuming BTC, adjust decimals as needed)
  const quantity = usdcAmount / entryPrice;

  // Leg 1 - TP Leg
  const tpLeg: PositionLeg = {
    id: generateLegId('TP', timestamp),
    positionId,
    type: 'TP',
    entryPrice,
    quantity,
    entryTime: timestamp,
    targetPrice: levels.takeProfitPrice,
    status: 'OPEN',
  };

  // Leg 2 - Runner
  // NO initial stop - only activates when TP leg closes (buy-and-hold mentality)
  const runnerLeg: PositionLeg = {
    id: generateLegId('RUNNER', timestamp),
    positionId,
    type: 'RUNNER',
    entryPrice,
    quantity,
    entryTime: timestamp,
    trailingStop: undefined, // No stop until TP leg closes
    highestPrice: entryPrice, // Track highest price for trailing stop
    status: 'OPEN',
  };

  logger?.info('Created two-leg position:', {
    entry: entryPrice,
    tpTarget: levels.takeProfitPrice,
    initialStop: levels.initialStopPrice,
    quantity,
    atr,
  });

  return [tpLeg, runnerLeg];
}

/**
 * Update position legs based on current price
 *
 * @param legs - Array of open position legs
 * @param currentPrice - Current BTC price
 * @param currentATR - Current ATR value
 * @param trailMultiplier - ATR multiplier for trailing stop
 * @param breakEvenLockMultiplier - Lock runner at entry + multiplier×ATR when TP closes
 * @param logger - Optional logger instance
 * @returns Updated array of legs (some may be closed)
 */
export function updatePositions(
  legs: PositionLeg[],
  currentPrice: number,
  currentATR: number,
  trailMultiplier: number = 2.5,
  breakEvenLockMultiplier: number = 0.25,
  logger?: Logger
): PositionLeg[] {
  const updatedLegs: PositionLeg[] = [];

  // Check if TP leg just closed (to activate runner stops)
  const tpJustClosed = legs.some(
    (leg) => leg.type === 'TP' && leg.status === 'OPEN' && currentPrice >= (leg.targetPrice || 0)
  );

  for (const leg of legs) {
    // Skip already closed legs
    if (leg.status === 'CLOSED') {
      updatedLegs.push(leg);
      continue;
    }

    const updatedLeg = { ...leg };

    if (leg.type === 'TP') {
      // Check if TP target hit
      if (currentPrice >= leg.targetPrice!) {
        updatedLeg.status = 'CLOSED';
        updatedLeg.closePrice = leg.targetPrice;
        updatedLeg.closeTime = Date.now();
        updatedLeg.closeReason = 'TP target hit';

        const profit = (leg.targetPrice! - leg.entryPrice) * leg.quantity;
        const profitPct = ((leg.targetPrice! - leg.entryPrice) / leg.entryPrice) * 100;

        logger?.info('TP leg closed:', {
          id: leg.id,
          entry: leg.entryPrice,
          exit: updatedLeg.closePrice,
          profit: profit.toFixed(4),
          profitPct: profitPct.toFixed(2) + '%',
        });
      }
    } else if (leg.type === 'RUNNER') {
      // Activate stop if TP just closed and runner has no stop yet
      if (tpJustClosed && leg.trailingStop === undefined) {
        const breakEvenLock = leg.entryPrice + (currentATR * breakEvenLockMultiplier);
        updatedLeg.trailingStop = breakEvenLock;

        logger?.info('Runner stop activated (TP closed):', {
          id: leg.id,
          entry: leg.entryPrice,
          lockPrice: breakEvenLock,
          lockMultiplier: breakEvenLockMultiplier,
          currentPrice,
        });
      }
      // Update highest price if we made a new high
      const newHighest = Math.max(leg.highestPrice || leg.entryPrice, currentPrice);
      updatedLeg.highestPrice = newHighest;

      // Only update/check trailing stop if it's active
      if (updatedLeg.trailingStop !== undefined) {
        // Update trailing stop (only moves up, never down)
        const newStop = updateTrailingStop(
          newHighest,
          updatedLeg.trailingStop,
          currentATR,
          trailMultiplier
        );
        updatedLeg.trailingStop = newStop;

        // Check if stop hit
        if (currentPrice <= newStop) {
          updatedLeg.status = 'CLOSED';
          updatedLeg.closePrice = newStop;
          updatedLeg.closeTime = Date.now();
          updatedLeg.closeReason = 'Trailing stop hit';

          const profit = (updatedLeg.closePrice - leg.entryPrice) * leg.quantity;
          const profitPct = ((updatedLeg.closePrice - leg.entryPrice) / leg.entryPrice) * 100;

          logger?.info('Runner leg closed:', {
            id: leg.id,
            entry: leg.entryPrice,
            highest: newHighest,
            exit: updatedLeg.closePrice,
            profit: profit.toFixed(4),
            profitPct: profitPct.toFixed(2) + '%',
          });
        } else {
          // Log trailing stop update if it moved
          if (leg.trailingStop !== undefined && newStop > leg.trailingStop) {
            logger?.info('Trailing stop updated:', {
              id: leg.id,
              oldStop: leg.trailingStop,
              newStop: newStop,
              highest: newHighest,
              currentPrice,
            });
          }
        }
      }
    }

    updatedLegs.push(updatedLeg);
  }

  return updatedLegs;
}

/**
 * Get only open position legs
 *
 * @param legs - Array of all position legs
 * @returns Array of only open legs
 */
export function getOpenLegs(legs: PositionLeg[]): PositionLeg[] {
  return legs.filter((leg) => leg.status === 'OPEN');
}

/**
 * Get only closed position legs
 *
 * @param legs - Array of all position legs
 * @returns Array of only closed legs
 */
export function getClosedLegs(legs: PositionLeg[]): PositionLeg[] {
  return legs.filter((leg) => leg.status === 'CLOSED');
}

/**
 * Check if we should close runner legs on SHORT signal
 * (MFI crossing below 70 = trim signal)
 *
 * @param legs - Array of position legs
 * @param signal - SHORT signal
 * @param logger - Optional logger instance
 * @returns Updated array with runners closed
 */
export function closeRunnersOnTrimSignal(
  legs: PositionLeg[],
  signal: Signal,
  logger?: Logger
): PositionLeg[] {
  if (signal.type !== 'SHORT') {
    return legs;
  }

  const updatedLegs = legs.map((leg) => {
    // Only close open RUNNER legs
    if (leg.type === 'RUNNER' && leg.status === 'OPEN') {
      const closedLeg = { ...leg };
      closedLeg.status = 'CLOSED';
      closedLeg.closePrice = signal.price;
      closedLeg.closeTime = signal.timestamp;
      closedLeg.closeReason = 'Trim signal (MFI < 70)';

      const profit = (closedLeg.closePrice - leg.entryPrice) * leg.quantity;
      const profitPct = ((closedLeg.closePrice - leg.entryPrice) / leg.entryPrice) * 100;

      logger?.info('Runner leg trimmed on signal:', {
        id: leg.id,
        entry: leg.entryPrice,
        exit: closedLeg.closePrice,
        mfi: signal.mfi,
        profit: profit.toFixed(4),
        profitPct: profitPct.toFixed(2) + '%',
      });

      return closedLeg;
    }

    return leg;
  });

  return updatedLegs;
}

/**
 * Calculate total unrealized PnL for open positions
 *
 * @param legs - Array of position legs
 * @param currentPrice - Current BTC price
 * @returns Unrealized profit/loss in USD
 */
export function calculateUnrealizedPnL(
  legs: PositionLeg[],
  currentPrice: number
): number {
  const openLegs = getOpenLegs(legs);

  return openLegs.reduce((total, leg) => {
    const pnl = (currentPrice - leg.entryPrice) * leg.quantity;
    return total + pnl;
  }, 0);
}

/**
 * Calculate total realized PnL for closed positions
 *
 * @param legs - Array of position legs
 * @returns Realized profit/loss in USD
 */
export function calculateRealizedPnL(legs: PositionLeg[]): number {
  const closedLegs = getClosedLegs(legs);

  return closedLegs.reduce((total, leg) => {
    if (leg.closePrice) {
      const pnl = (leg.closePrice - leg.entryPrice) * leg.quantity;
      return total + pnl;
    }
    return total;
  }, 0);
}

/**
 * Get position summary for logging
 *
 * @param legs - Array of position legs
 * @param currentPrice - Current BTC price (optional)
 * @returns Summary object
 */
export function getPositionSummary(
  legs: PositionLeg[],
  currentPrice?: number
): {
  totalLegs: number;
  openLegs: number;
  closedLegs: number;
  realizedPnL: number;
  unrealizedPnL: number;
} {
  const openCount = getOpenLegs(legs).length;
  const closedCount = getClosedLegs(legs).length;
  const realized = calculateRealizedPnL(legs);
  const unrealized = currentPrice ? calculateUnrealizedPnL(legs, currentPrice) : 0;

  return {
    totalLegs: legs.length,
    openLegs: openCount,
    closedLegs: closedCount,
    realizedPnL: realized,
    unrealizedPnL: unrealized,
  };
}
