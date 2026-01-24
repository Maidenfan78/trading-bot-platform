import axios from 'axios';
import type { Candle, Logger } from '../types';

/**
 * Binance API Integration for Candle Data
 *
 * Fetches OHLCV candles from Binance's public API.
 * No API key required for public market data.
 *
 * API Endpoint: https://api.binance.com/api/v3/klines
 * Documentation: https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
 */

const BINANCE_API_BASE = 'https://api.binance.com';
const BINANCE_KLINES_ENDPOINT = '/api/v3/klines';

export type BinanceInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';

export interface BinanceFetcherConfig {
  symbol: string;
  interval: BinanceInterval;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Binance Candle Fetcher
 *
 * Configurable candle fetcher for any symbol and interval.
 */
export class BinanceFetcher {
  private config: BinanceFetcherConfig;
  private logger?: Logger;

  constructor(config: BinanceFetcherConfig, logger?: Logger) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || BINANCE_API_BASE,
      timeout: config.timeout || 10000,
    };
    this.logger = logger;
  }

  /**
   * Fetch candles from Binance
   *
   * @param limit - Number of candles to fetch (default: 400, max: 1000)
   * @returns Array of Candle objects in chronological order
   */
  async fetchCandles(limit: number = 400): Promise<Candle[]> {
    try {
      this.logger?.info(`Fetching ${limit} ${this.config.interval} candles for ${this.config.symbol} from Binance`);

      const url = `${this.config.baseUrl}${BINANCE_KLINES_ENDPOINT}`;
      const params = {
        symbol: this.config.symbol,
        interval: this.config.interval,
        limit: Math.min(limit, 1000), // Binance max is 1000
      };

      const response = await axios.get(url, { params, timeout: this.config.timeout });

      if (!Array.isArray(response.data)) {
        throw new Error('Invalid response format from Binance API');
      }

      const candles: Candle[] = response.data.map((kline: any[]) => ({
        timestamp: kline[0], // Open time in ms
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
      }));

      this.logger?.info(
        `Successfully fetched ${candles.length} candles. Latest: ${new Date(
          candles[candles.length - 1].timestamp
        ).toISOString()}`
      );

      return candles;
    } catch (error: any) {
      this.logger?.error('Failed to fetch Binance candles:', {
        error: error.message,
        symbol: this.config.symbol,
        interval: this.config.interval,
        limit,
      });
      throw new Error(`Binance API error: ${error.message}`);
    }
  }

  /**
   * Fetch the latest completed candle
   *
   * Note: Binance returns the current (incomplete) candle as the last element.
   * This function returns the second-to-last element to ensure we only trade
   * on completed candles.
   */
  async fetchLatestCompletedCandle(): Promise<Candle> {
    const candles = await this.fetchCandles(2);

    if (candles.length < 2) {
      throw new Error('Insufficient candle data from Binance');
    }

    // Return second-to-last candle (last completed candle)
    const completedCandle = candles[candles.length - 2];

    this.logger?.info(
      `Latest completed candle: ${new Date(completedCandle.timestamp).toISOString()}`
    );

    return completedCandle;
  }

  /**
   * Check if a new candle has completed since last check
   */
  async hasNewCandle(lastProcessedTime: number): Promise<boolean> {
    try {
      const latestCandle = await this.fetchLatestCompletedCandle();
      const hasNew = latestCandle.timestamp > lastProcessedTime;

      if (hasNew) {
        this.logger?.info(
          `New candle detected! Last: ${new Date(lastProcessedTime).toISOString()}, New: ${new Date(
            latestCandle.timestamp
          ).toISOString()}`
        );
      }

      return hasNew;
    } catch (error: any) {
      this.logger?.error('Error checking for new candle:', error.message);
      throw error;
    }
  }

  /**
   * Get the symbol being fetched
   */
  getSymbol(): string {
    return this.config.symbol;
  }

  /**
   * Get the interval being fetched
   */
  getInterval(): BinanceInterval {
    return this.config.interval;
  }
}

/**
 * Validate candle data quality
 */
export function isValidCandle(candle: Candle, logger?: Logger): boolean {
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
    logger?.warn('Invalid candle: negative or zero prices');
    return false;
  }

  if (candle.high < candle.low) {
    logger?.warn('Invalid candle: high < low');
    return false;
  }

  if (candle.high < candle.open || candle.high < candle.close) {
    logger?.warn('Invalid candle: high is not highest price');
    return false;
  }

  if (candle.low > candle.open || candle.low > candle.close) {
    logger?.warn('Invalid candle: low is not lowest price');
    return false;
  }

  if (candle.volume < 0) {
    logger?.warn('Invalid candle: negative volume');
    return false;
  }

  return true;
}

/**
 * Validate entire candle array
 */
export function validateCandleArray(candles: Candle[], logger?: Logger): boolean {
  if (candles.length === 0) {
    logger?.warn('Empty candle array');
    return false;
  }

  // Check each candle
  for (let i = 0; i < candles.length; i++) {
    if (!isValidCandle(candles[i], logger)) {
      logger?.warn(`Invalid candle at index ${i}`);
      return false;
    }
  }

  // Check chronological order
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timestamp <= candles[i - 1].timestamp) {
      logger?.warn(`Candles not in chronological order at index ${i}`);
      return false;
    }
  }

  return true;
}

/**
 * Helper to create fetcher for common configurations
 */
export function createBTCDailyFetcher(logger?: Logger): BinanceFetcher {
  return new BinanceFetcher({ symbol: 'BTCUSDT', interval: '1d' }, logger);
}

export function createBTC4HFetcher(logger?: Logger): BinanceFetcher {
  return new BinanceFetcher({ symbol: 'BTCUSDT', interval: '4h' }, logger);
}

export function createBTC1HFetcher(logger?: Logger): BinanceFetcher {
  return new BinanceFetcher({ symbol: 'BTCUSDT', interval: '1h' }, logger);
}
