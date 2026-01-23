import fs from 'fs';
import path from 'path';
import { PositionLeg, Logger } from '../types';

/**
 * Trading CSV Logger for Position Trading Strategy
 *
 * Logs data relevant to MFI-based position trading with multiple legs
 * Focuses on: entry/exit tracking, P&L analysis, position management
 */

/**
 * Format a price with appropriate precision based on magnitude.
 * Low-priced assets (like JUP at ~$0.19) need more decimal places
 * to avoid significant rounding errors.
 */
function formatPrice(price: number): string {
  if (price >= 100) {
    return price.toFixed(2);      // BTC, ETH: $3017.70
  } else if (price >= 1) {
    return price.toFixed(4);      // SOL, UNI: $128.0800
  } else if (price >= 0.01) {
    return price.toFixed(6);      // JUP: $0.195473
  } else {
    return price.toFixed(8);      // Sub-cent tokens
  }
}

/**
 * Trade Entry Log
 * Logs every position opening with all relevant context
 */
export interface TradeEntry {
  date: string;
  timestamp: number;
  asset: string;  // BTC, wETH, SOL, JUP
  action: 'OPEN';
  signalType: 'LONG';
  mfi: number;
  atr: number;
  price: number;
  totalUSDC: number;
  totalQuantity: number;
  legsOpened: number;
  targetPrice: number;
  trailingStop: number;
  mode: 'PAPER' | 'LIVE';
}

/**
 * Trade Exit Log
 * Logs every position leg closure with P&L
 */
export interface TradeExit {
  date: string;
  timestamp: number;
  asset: string;
  legId: string;
  legType: 'TP' | 'RUNNER';
  entryDate: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  holdingPeriod: string;  // e.g., "2d 5h"
  exitReason: string;
  pnlUSDC: number;
  pnlPercent: number;
  mode: 'PAPER' | 'LIVE';
}

/**
 * Daily Summary Log
 * End-of-day portfolio snapshot
 */
export interface DailySummary {
  date: string;
  asset: string;
  price: number;
  usdcBalance: number;
  assetBalance: number;
  portfolioValue: number;
  openPositions: number;
  totalReturn: number;
  totalReturnPct: number;
  tradesOpened: number;
  tradesClosed: number;
  winnersToday: number;
  losersToday: number;
  mode: 'PAPER' | 'LIVE';
}

/**
 * Trading CSV Logger configuration
 */
export interface TradingCSVLoggerConfig {
  csvDir: string;
  logger?: Logger;
}

/**
 * Format holding period in human-readable form
 */
function formatHoldingPeriod(entryTime: number, exitTime: number): string {
  const diff = exitTime - entryTime;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h`;
}

/**
 * Create a trading CSV logger instance
 */
export function createTradingCSVLogger(config: TradingCSVLoggerConfig) {
  const { csvDir, logger } = config;

  // Ensure CSV directory exists
  if (!fs.existsSync(csvDir)) {
    fs.mkdirSync(csvDir, { recursive: true });
  }

  /**
   * Append trade entry to CSV
   */
  function logTradeEntry(entry: TradeEntry, filename: string = 'trade-entries.csv'): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Create file with header if it doesn't exist
      if (!fs.existsSync(filepath)) {
        const header = 'Date,Timestamp,Asset,Action,SignalType,MFI,ATR,Price,TotalUSDC,TotalQuantity,LegsOpened,TargetPrice,TrailingStop,Mode\n';
        fs.writeFileSync(filepath, header, 'utf-8');
      }

      // Append row
      const row = [
        entry.date,
        entry.timestamp,
        entry.asset,
        entry.action,
        entry.signalType,
        entry.mfi.toFixed(2),
        formatPrice(entry.atr),
        formatPrice(entry.price),
        entry.totalUSDC.toFixed(2),
        entry.totalQuantity.toFixed(8),
        entry.legsOpened,
        formatPrice(entry.targetPrice),
        formatPrice(entry.trailingStop),
        entry.mode,
      ].join(',') + '\n';

      fs.appendFileSync(filepath, row, 'utf-8');
      logger?.info(`CSV: Trade entry logged to ${filename}`);
    } catch (error: any) {
      logger?.error('Failed to log trade entry:', error.message);
    }
  }

  /**
   * Append trade exit to CSV
   */
  function logTradeExit(exit: TradeExit, filename: string = 'trade-exits.csv'): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Create file with header if it doesn't exist
      if (!fs.existsSync(filepath)) {
        const header = 'Date,Timestamp,Asset,LegID,LegType,EntryDate,EntryPrice,ExitPrice,Quantity,HoldingPeriod,ExitReason,PnL_USDC,PnL_Percent,Mode\n';
        fs.writeFileSync(filepath, header, 'utf-8');
      }

      // Append row
      const row = [
        exit.date,
        exit.timestamp,
        exit.asset,
        exit.legId,
        exit.legType,
        exit.entryDate,
        formatPrice(exit.entryPrice),
        formatPrice(exit.exitPrice),
        exit.quantity.toFixed(8),
        exit.holdingPeriod,
        `"${exit.exitReason}"`,  // Quote in case it has commas
        exit.pnlUSDC.toFixed(2),
        exit.pnlPercent.toFixed(2),
        exit.mode,
      ].join(',') + '\n';

      fs.appendFileSync(filepath, row, 'utf-8');
      logger?.info(`CSV: Trade exit logged to ${filename} (${exit.pnlPercent > 0 ? 'WIN' : 'LOSS'}: ${exit.pnlPercent.toFixed(2)}%)`);
    } catch (error: any) {
      logger?.error('Failed to log trade exit:', error.message);
    }
  }

  /**
   * Append daily summary to CSV
   */
  function logDailySummary(summary: DailySummary, filename: string = 'daily-summary.csv'): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Create file with header if it doesn't exist
      if (!fs.existsSync(filepath)) {
        const header = 'Date,Asset,Price,USDC_Balance,Asset_Balance,Portfolio_Value,Open_Positions,Total_Return,Total_Return_Pct,Trades_Opened,Trades_Closed,Winners,Losers,Mode\n';
        fs.writeFileSync(filepath, header, 'utf-8');
      }

      // Append row
      const row = [
        summary.date,
        summary.asset,
        formatPrice(summary.price),
        summary.usdcBalance.toFixed(2),
        summary.assetBalance.toFixed(8),
        summary.portfolioValue.toFixed(2),
        summary.openPositions,
        summary.totalReturn.toFixed(2),
        summary.totalReturnPct.toFixed(2),
        summary.tradesOpened,
        summary.tradesClosed,
        summary.winnersToday,
        summary.losersToday,
        summary.mode,
      ].join(',') + '\n';

      fs.appendFileSync(filepath, row, 'utf-8');
      logger?.info(`CSV: Daily summary logged to ${filename}`);
    } catch (error: any) {
      logger?.error('Failed to log daily summary:', error.message);
    }
  }

  /**
   * Log a position leg closure
   * Convenience function that creates TradeExit from leg data
   */
  function logPositionLegClosure(
    leg: PositionLeg,
    asset: string,
    mode: 'PAPER' | 'LIVE',
    filename?: string
  ): void {
    if (!leg.closePrice || !leg.closeTime) {
      logger?.warn('Cannot log leg closure - missing close data');
      return;
    }

    const pnl = (leg.closePrice - leg.entryPrice) * leg.quantity;
    const pnlPct = ((leg.closePrice - leg.entryPrice) / leg.entryPrice) * 100;

    const exit: TradeExit = {
      date: new Date(leg.closeTime).toISOString(),
      timestamp: leg.closeTime,
      asset,
      legId: leg.id,
      legType: leg.type,
      entryDate: new Date(leg.entryTime).toISOString(),
      entryPrice: leg.entryPrice,
      exitPrice: leg.closePrice,
      quantity: leg.quantity,
      holdingPeriod: formatHoldingPeriod(leg.entryTime, leg.closeTime),
      exitReason: leg.closeReason || 'Unknown',
      pnlUSDC: pnl,
      pnlPercent: pnlPct,
      mode,
    };

    logTradeExit(exit, filename);
  }

  /**
   * Log multiple leg closures (bulk operation)
   */
  function logPositionLegClosures(
    legs: PositionLeg[],
    asset: string,
    mode: 'PAPER' | 'LIVE',
    filename?: string
  ): void {
    const closedLegs = legs.filter(leg => leg.status === 'CLOSED' && leg.closePrice && leg.closeTime);

    for (const leg of closedLegs) {
      logPositionLegClosure(leg, asset, mode, filename);
    }

    if (closedLegs.length > 0) {
      const totalPnL = closedLegs.reduce((sum, leg) => {
        return sum + (leg.closePrice! - leg.entryPrice) * leg.quantity;
      }, 0);

      logger?.info(`CSV: Logged ${closedLegs.length} leg closure(s), Total P&L: $${totalPnL.toFixed(2)}`);
    }
  }

  return {
    logTradeEntry,
    logTradeExit,
    logDailySummary,
    logPositionLegClosure,
    logPositionLegClosures,
  };
}

export type TradingCSVLogger = ReturnType<typeof createTradingCSVLogger>;
