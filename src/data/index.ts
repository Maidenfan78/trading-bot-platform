/**
 * Data Module
 *
 * Exports data fetching utilities.
 */

export {
  BinanceFetcher,
  isValidCandle,
  validateCandleArray,
  createBTCDailyFetcher,
  createBTC4HFetcher,
  createBTC1HFetcher,
  type BinanceFetcherConfig,
  type BinanceInterval,
} from './BinanceFetcher';
