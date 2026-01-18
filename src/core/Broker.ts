import { Signal, PositionLeg, Candle, SwapResult } from '../types';

/**
 * Broker Interface
 *
 * Defines the contract for trade execution brokers.
 * Implementations include PaperBroker (simulated) and LiveBroker (real trades).
 */
export interface Broker {
  /**
   * Open a new position based on a signal
   *
   * @param signal - Trading signal (must be LONG for opening)
   * @param candle - Current candle for price reference
   * @returns Array of position legs created, or null if failed
   */
  openPosition(signal: Signal, candle: Candle): Promise<PositionLeg[] | null>;

  /**
   * Close a specific position leg
   *
   * @param leg - Position leg to close
   * @param candle - Current candle for price reference
   * @param reason - Reason for closing
   * @returns Swap result or void (paper mode doesn't return swap result)
   */
  closeLeg(leg: PositionLeg, candle: Candle, reason: string): Promise<SwapResult | void>;

  /**
   * Update positions and close any that hit targets/stops
   *
   * @param legs - Array of position legs to update
   * @param candle - Current candle for price reference
   * @param currentATR - Current ATR value
   * @returns Updated array of legs
   */
  updateAndClosePositions(
    legs: PositionLeg[],
    candle: Candle,
    currentATR: number
  ): Promise<PositionLeg[]>;

  /**
   * Close all runner legs on trim signal
   *
   * @param legs - Array of position legs
   * @param signal - SHORT signal for trimming
   * @param candle - Current candle for price reference
   * @returns Updated array of legs
   */
  trimRunners(
    legs: PositionLeg[],
    signal: Signal,
    candle: Candle
  ): Promise<PositionLeg[]>;

  /**
   * Get current portfolio value
   *
   * @param currentPrice - Current asset price
   * @returns Portfolio value in USDC
   */
  getPortfolioValue(currentPrice: number): Promise<number>;

  /**
   * Get account summary for logging
   *
   * @param currentPrice - Current asset price
   * @returns Human-readable summary string
   */
  getSummary(currentPrice: number): Promise<string>;
}

/**
 * Account state interface for paper trading
 */
export interface PaperAccount {
  usdcBalance: number;
  btcBalance: number;
  initialCapital: number;
  totalDeposited: number;
  totalWithdrawn: number;
}

/**
 * Paper trade execution record
 */
export interface PaperTradeExecution {
  timestamp: number;
  signal: Signal;
  action: 'OPEN_POSITION' | 'CLOSE_TP' | 'CLOSE_RUNNER' | 'TRIM_RUNNERS';
  price: number;
  usdcAmount?: number;
  btcAmount?: number;
  slippage: number;
  legs?: PositionLeg[];
}

/**
 * Paper broker configuration
 */
export interface PaperBrokerConfig {
  initialUsdcBalance: number;
  initialBtcBalance: number;
  slippageBps: number;
  tradeLegUsdc: number;
  atrTpMultiplier?: number;
  atrTrailMultiplier?: number;
  breakEvenLockMultiplier?: number;
}

/**
 * Live broker configuration
 */
export interface LiveBrokerConfig {
  rpcUrl: string;
  walletSecretKey: string;
  usdcMint: string;
  cbBtcMint: string;
  wbtcMint: string;
  slippageBps: number;
  maxPriceImpactBps: number;
  tradeLegUsdc: number;
  atrTpMultiplier: number;
  atrTrailMultiplier: number;
  minBtcBalance: number;
  minUsdcReserve: number;
}
