import fs from 'fs';
import path from 'path';
import { Candle, Signal, PositionLeg, Logger } from '../types';

/**
 * CSV Logging Utilities
 *
 * Writes trading data to CSV files for analysis in Excel/Google Sheets
 */

/**
 * Format a price with appropriate precision based on magnitude.
 * Low-priced assets need more decimal places to avoid rounding errors.
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
 * CSV Logger configuration
 */
export interface CSVLoggerConfig {
  csvDir: string;
  logger?: Logger;
}

/**
 * Paper Trade Execution record for logging
 */
export interface PaperTradeExecution {
  timestamp: number;
  action: 'BUY' | 'SELL';
  price: number;
  signal: Signal;
  usdcAmount?: number;
  btcAmount?: number;
  slippage: number;
}

/**
 * Equity Snapshot for daily tracking
 */
export interface EquitySnapshot {
  date: string;
  timestamp: number;
  btcPrice: number;
  usdcBalance: number;
  btcBalance: number;
  portfolioValue: number;
  totalReturn: number;
  totalReturnPct: number;
  openPositions: number;
}

/**
 * Create a CSV logger instance
 */
export function createCSVLogger(config: CSVLoggerConfig) {
  const { csvDir, logger } = config;

  // Ensure CSV directory exists
  if (!fs.existsSync(csvDir)) {
    fs.mkdirSync(csvDir, { recursive: true });
  }

  /**
   * Format a date for CSV
   */
  function formatDate(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  /**
   * Escape CSV field (handles commas and quotes)
   */
  function escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Log candle data with indicators
   */
  function logCandleData(
    candles: Candle[],
    mfiSeries: (number | null)[],
    atrSeries: (number | null)[],
    filename: string = 'candles.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Header
      const header = 'Date,Timestamp,Open,High,Low,Close,Volume,MFI,ATR\n';

      // Data rows
      const rows = candles.map((candle, i) => {
        const date = formatDate(candle.timestamp);
        const mfi = mfiSeries[i] !== null ? mfiSeries[i]!.toFixed(2) : '';
        const atr = atrSeries[i] !== null ? atrSeries[i]!.toFixed(2) : '';

        return [
          date,
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          mfi,
          atr,
        ].join(',');
      });

      const csv = header + rows.join('\n') + '\n';
      fs.writeFileSync(filepath, csv, 'utf-8');

      logger?.info(`Candle data logged to ${filename}`);
    } catch (error: any) {
      logger?.error('Failed to write candle CSV:', error.message);
    }
  }

  /**
   * Log signal history
   */
  function logSignals(
    signals: Array<{ candle: Candle; signal: Signal }>,
    filename: string = 'signals.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Header
      const header = 'Date,Timestamp,Price,MFI,ATR,SignalType,Action\n';

      // Data rows
      const rows = signals.map(({ candle, signal }) => {
        const date = formatDate(candle.timestamp);
        const action =
          signal.type === 'LONG'
            ? 'OPEN POSITION'
            : signal.type === 'SHORT'
            ? 'TRIM/REDUCE'
            : 'NONE';

        return [
          date,
          candle.timestamp,
          signal.price.toFixed(2),
          signal.mfi.toFixed(2),
          signal.atr.toFixed(2),
          signal.type,
          action,
        ].join(',');
      });

      const csv = header + rows.join('\n') + '\n';
      fs.writeFileSync(filepath, csv, 'utf-8');

      logger?.info(`Signal history logged to ${filename}`);
    } catch (error: any) {
      logger?.error('Failed to write signals CSV:', error.message);
    }
  }

  /**
   * Log trade executions
   */
  function logTrades(
    trades: PaperTradeExecution[],
    filename: string = 'trades.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Header
      const header =
        'Date,Timestamp,Action,Price,SignalType,MFI,USDCAmount,BTCAmount,Slippage\n';

      // Data rows
      const rows = trades.map((trade) => {
        const date = formatDate(trade.timestamp);

        return [
          date,
          trade.timestamp,
          trade.action,
          trade.price.toFixed(2),
          trade.signal.type,
          trade.signal.mfi.toFixed(2),
          trade.usdcAmount !== undefined ? trade.usdcAmount.toFixed(2) : '',
          trade.btcAmount !== undefined ? trade.btcAmount.toFixed(8) : '',
          trade.slippage.toFixed(2),
        ].join(',');
      });

      const csv = header + rows.join('\n') + '\n';
      fs.writeFileSync(filepath, csv, 'utf-8');

      logger?.info(`Trade history logged to ${filename} (${trades.length} trades)`);
    } catch (error: any) {
      logger?.error('Failed to write trades CSV:', error.message);
    }
  }

  /**
   * Log position legs (detailed trade log)
   */
  function logPositionLegs(
    legs: PositionLeg[],
    filename: string = 'positions.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Header
      const header =
        'LegID,Type,Status,EntryTime,EntryPrice,Quantity,TargetPrice,TrailingStop,HighestPrice,CloseTime,ClosePrice,CloseReason,PnL,PnLPct\n';

      // Data rows
      const rows = legs.map((leg) => {
        const entryDate = formatDate(leg.entryTime);
        const closeDate = leg.closeTime ? formatDate(leg.closeTime) : '';
        const pnl = leg.closePrice
          ? ((leg.closePrice - leg.entryPrice) * leg.quantity).toFixed(4)
          : '';
        const pnlPct = leg.closePrice
          ? (((leg.closePrice - leg.entryPrice) / leg.entryPrice) * 100).toFixed(2)
          : '';

        return [
          leg.id,
          leg.type,
          leg.status,
          entryDate,
          formatPrice(leg.entryPrice),
          leg.quantity.toFixed(8),
          leg.targetPrice !== undefined ? formatPrice(leg.targetPrice) : '',
          leg.trailingStop !== undefined ? formatPrice(leg.trailingStop) : '',
          leg.highestPrice !== undefined ? formatPrice(leg.highestPrice) : '',
          closeDate,
          leg.closePrice !== undefined ? formatPrice(leg.closePrice) : '',
          escapeCSV(leg.closeReason || ''),
          pnl,
          pnlPct,
        ].join(',');
      });

      const csv = header + rows.join('\n') + '\n';
      fs.writeFileSync(filepath, csv, 'utf-8');

      logger?.info(`Position legs logged to ${filename} (${legs.length} legs)`);
    } catch (error: any) {
      logger?.error('Failed to write positions CSV:', error.message);
    }
  }

  /**
   * Log equity curve (daily portfolio value)
   */
  function logEquityCurve(
    snapshots: EquitySnapshot[],
    filename: string = 'equity-curve.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Header
      const header =
        'Date,Timestamp,BTCPrice,USDCBalance,BTCBalance,PortfolioValue,TotalReturn,TotalReturnPct,OpenPositions\n';

      // Data rows
      const rows = snapshots.map((snapshot) => {
        return [
          snapshot.date,
          snapshot.timestamp,
          formatPrice(snapshot.btcPrice),
          snapshot.usdcBalance.toFixed(2),
          snapshot.btcBalance.toFixed(8),
          snapshot.portfolioValue.toFixed(2),
          snapshot.totalReturn.toFixed(2),
          snapshot.totalReturnPct.toFixed(2),
          snapshot.openPositions,
        ].join(',');
      });

      const csv = header + rows.join('\n') + '\n';
      fs.writeFileSync(filepath, csv, 'utf-8');

      logger?.info(`Equity curve logged to ${filename} (${snapshots.length} snapshots)`);
    } catch (error: any) {
      logger?.error('Failed to write equity curve CSV:', error.message);
    }
  }

  /**
   * Append equity snapshot to existing file (for live tracking)
   */
  function appendEquitySnapshot(
    snapshot: EquitySnapshot,
    filename: string = 'equity-curve.csv'
  ): void {
    try {
      const filepath = path.join(csvDir, filename);

      // Create file with header if it doesn't exist
      if (!fs.existsSync(filepath)) {
        const header =
          'Date,Timestamp,BTCPrice,USDCBalance,BTCBalance,PortfolioValue,TotalReturn,TotalReturnPct,OpenPositions\n';
        fs.writeFileSync(filepath, header, 'utf-8');
      }

      // Append row
      const row =
        [
          snapshot.date,
          snapshot.timestamp,
          formatPrice(snapshot.btcPrice),
          snapshot.usdcBalance.toFixed(2),
          snapshot.btcBalance.toFixed(8),
          snapshot.portfolioValue.toFixed(2),
          snapshot.totalReturn.toFixed(2),
          snapshot.totalReturnPct.toFixed(2),
          snapshot.openPositions,
        ].join(',') + '\n';

      fs.appendFileSync(filepath, row, 'utf-8');
    } catch (error: any) {
      logger?.error('Failed to append equity snapshot:', error.message);
    }
  }

  /**
   * Generate a comprehensive trading report
   */
  function generateTradingReport(
    candles: Candle[],
    mfiSeries: (number | null)[],
    atrSeries: (number | null)[],
    trades: PaperTradeExecution[],
    legs: PositionLeg[],
    equitySnapshots: EquitySnapshot[]
  ): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];

    logCandleData(candles, mfiSeries, atrSeries, `${timestamp}-candles.csv`);
    logTrades(trades, `${timestamp}-trades.csv`);
    logPositionLegs(legs, `${timestamp}-positions.csv`);
    logEquityCurve(equitySnapshots, `${timestamp}-equity-curve.csv`);

    logger?.info(`Trading report generated with prefix: ${timestamp}`);
  }

  return {
    logCandleData,
    logSignals,
    logTrades,
    logPositionLegs,
    logEquityCurve,
    appendEquitySnapshot,
    generateTradingReport,
  };
}

export type CSVLogger = ReturnType<typeof createCSVLogger>;
