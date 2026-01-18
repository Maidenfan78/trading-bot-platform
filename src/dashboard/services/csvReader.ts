import { readFileSync, readdirSync, existsSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { join } from 'path';
import { TradeEntry, PositionLeg, EquityPoint, BotConfig } from '../types';

/**
 * CSV Reader Service
 *
 * Reads trade data from CSV log files.
 */
export class CSVReader {
  private effectiveCsvDir: string;
  private getBotConfigFn?: (botId: string) => BotConfig | undefined;

  constructor(
    private csvLogsDir: string,
    botCsvDir?: string,
    getBotConfig?: (botId: string) => BotConfig | undefined
  ) {
    // If botCsvDir provided, use it as a subdirectory
    this.effectiveCsvDir = botCsvDir ? join(csvLogsDir, botCsvDir) : csvLogsDir;
    this.getBotConfigFn = getBotConfig;
  }

  /**
   * Get the CSV directory for a specific bot
   */
  getBotCsvDir(botId: string): string {
    if (this.getBotConfigFn) {
      const botConfig = this.getBotConfigFn(botId);
      if (botConfig?.csvDir) {
        return join(this.csvLogsDir, botConfig.csvDir);
      }
    }
    // Fallback to base directory if bot not found
    return this.csvLogsDir;
  }

  /**
   * Read trades from CSV files
   */
  readTrades(limit?: number, offset = 0): TradeEntry[] {
    const tradeFiles = this.getAllCSVFiles('trades');
    const allTrades: TradeEntry[] = [];

    for (const file of tradeFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        const records = parse(content, {
          columns: true,
          skip_empty_lines: true,
        });

        for (const row of records) {
          allTrades.push({
            date: row.Date,
            timestamp: new Date(row.Date).getTime(),
            action: row.Action,
            price: parseFloat(row.Price),
            signalType: row.SignalType,
            mfi: parseFloat(row.MFI),
            usdcAmount: parseFloat(row.USDCAmount || row.AmountUSDC || '0'),
            btcAmount: parseFloat(row.BTCAmount || row.AmountBTC || '0'),
            slippage: row.Slippage ? parseFloat(row.Slippage) : undefined,
            asset: row.Asset,
          });
        }
      } catch (error) {
        console.error(`Failed to read trades file ${file}:`, error);
      }
    }

    // Sort by timestamp descending (newest first)
    allTrades.sort((a, b) => b.timestamp - a.timestamp);

    if (limit) {
      return allTrades.slice(offset, offset + limit);
    }

    return allTrades.slice(offset);
  }

  /**
   * Read positions from CSV files (from effectiveCsvDir)
   */
  readPositions(): PositionLeg[] {
    return this.readPositionsFromDir(this.effectiveCsvDir);
  }

  /**
   * Read positions from CSV files for a specific bot
   */
  readPositionsForBot(botId: string): PositionLeg[] {
    const botCsvDir = this.getBotCsvDir(botId);
    return this.readPositionsFromDir(botCsvDir);
  }

  /**
   * Read positions from a specific directory
   */
  private readPositionsFromDir(dir: string): PositionLeg[] {
    // Look for both 'positions' and 'trade-exits' files
    const positionFiles = [
      ...this.getAllCSVFilesFromDir(dir, 'positions'),
      ...this.getAllCSVFilesFromDir(dir, 'trade-exits'),
    ];
    const allPositions: PositionLeg[] = [];

    for (const file of positionFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        const records = parse(content, {
          columns: true,
          skip_empty_lines: true,
        });

        for (const row of records) {
          allPositions.push(this.mapToPositionLeg(row));
        }
      } catch (error) {
        console.error(`Failed to read positions file ${file}:`, error);
      }
    }

    return allPositions;
  }

  /**
   * Read equity curve from CSV files
   */
  readEquityCurve(): EquityPoint[] {
    const equityFiles = this.getAllCSVFiles('equity-curve');
    const allPoints: EquityPoint[] = [];

    for (const file of equityFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        const records = parse(content, {
          columns: true,
          skip_empty_lines: true,
        });

        for (const row of records) {
          allPoints.push({
            timestamp: new Date(row.Date).getTime(),
            equity: parseFloat(row.PortfolioValue || row.Equity || row.EquityUSDC || '0'),
          });
        }
      } catch (error) {
        console.error(`Failed to read equity curve file ${file}:`, error);
      }
    }

    // Sort by timestamp ascending (oldest first for chart)
    allPoints.sort((a, b) => a.timestamp - b.timestamp);

    return allPoints;
  }

  /**
   * Get all CSV files matching a prefix from base csvLogsDir
   */
  private getAllCSVFiles(prefix: string): string[] {
    return this.getAllCSVFilesFromDir(this.csvLogsDir, prefix);
  }

  /**
   * Get all CSV files matching a prefix from a specific directory
   */
  private getAllCSVFilesFromDir(dir: string, prefix: string): string[] {
    if (!existsSync(dir)) {
      return [];
    }

    const files = readdirSync(dir)
      .filter((f) => f.includes(prefix) && f.endsWith('.csv'))
      .map((f) => join(dir, f));

    // Sort by filename ascending
    files.sort();

    return files;
  }

  /**
   * Map CSV row to PositionLeg
   */
  private mapToPositionLeg(row: Record<string, string>): PositionLeg {
    // Handle trade-exits format
    if (row.LegType || row.ExitPrice) {
      return {
        id: row.LegID,
        type: (row.LegType || row.Type) as 'TP' | 'RUNNER',
        entryPrice: parseFloat(row.EntryPrice),
        quantity: parseFloat(row.Quantity),
        entryTime: row.EntryDate ? new Date(row.EntryDate).getTime() : new Date(row.EntryTime).getTime(),
        targetPrice: undefined,
        trailingStop: undefined,
        highestPrice: undefined,
        status: 'CLOSED' as const,
        closePrice: parseFloat(row.ExitPrice),
        closeTime: row.Date ? new Date(row.Date).getTime() : undefined,
        closeReason: row.ExitReason,
        pnlUsdc: row.PnL_USDC ? parseFloat(row.PnL_USDC) : undefined,
        pnlPercent: row.PnL_Percent ? parseFloat(row.PnL_Percent) : undefined,
        asset: row.Asset,
      };
    }

    // Handle original positions format
    return {
      id: row.LegID,
      type: row.Type as 'TP' | 'RUNNER',
      entryPrice: parseFloat(row.EntryPrice),
      quantity: parseFloat(row.Quantity),
      entryTime: new Date(row.EntryTime).getTime(),
      targetPrice: row.TargetPrice ? parseFloat(row.TargetPrice) : undefined,
      trailingStop: row.TrailingStop ? parseFloat(row.TrailingStop) : undefined,
      highestPrice: row.HighestPrice ? parseFloat(row.HighestPrice) : undefined,
      status: row.Status as 'OPEN' | 'CLOSED',
      closePrice: row.ClosePrice ? parseFloat(row.ClosePrice) : undefined,
      closeTime: row.CloseTime ? new Date(row.CloseTime).getTime() : undefined,
      closeReason: row.CloseReason,
    };
  }

  /**
   * Calculate performance metrics from positions
   */
  calculateMetrics(positions: PositionLeg[]): {
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalPnL: number;
    avgWin: number;
    avgLoss: number;
  } {
    const closedPositions = positions.filter((p) => p.status === 'CLOSED');
    const wins = closedPositions.filter((p) => {
      if (!p.closePrice || !p.entryPrice) return false;
      return (p.closePrice - p.entryPrice) > 0;
    });
    const losses = closedPositions.filter((p) => {
      if (!p.closePrice || !p.entryPrice) return false;
      return (p.closePrice - p.entryPrice) < 0;
    });

    const totalWins = wins.reduce((sum, p) => {
      return sum + ((p.closePrice! - p.entryPrice) * p.quantity);
    }, 0);

    const totalLosses = Math.abs(
      losses.reduce((sum, p) => {
        return sum + ((p.closePrice! - p.entryPrice) * p.quantity);
      }, 0)
    );

    return {
      totalTrades: closedPositions.length,
      winRate: closedPositions.length > 0 ? (wins.length / closedPositions.length) : 0,
      profitFactor: totalLosses > 0 ? totalWins / totalLosses : 0,
      totalPnL: totalWins - totalLosses,
      avgWin: wins.length > 0 ? totalWins / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
    };
  }
}
