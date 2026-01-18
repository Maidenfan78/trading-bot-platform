/**
 * Core type definitions for the Trading Bot Platform
 */

// ============================================================================
// Candle & Market Data
// ============================================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================================
// Indicator Results
// ============================================================================

export interface MFIResult {
  value: number;
  timestamp: number;
}

export interface ATRResult {
  value: number;
  timestamp: number;
}

export interface TCF2Result {
  line1: number;
  line2: number;
  timestamp: number;
}

export interface KPSSResult {
  value: number;
  signal: number;
  timestamp: number;
}

export interface TDFIResult {
  value: number;
  timestamp: number;
}

export interface DSSMOMResult {
  dss: number;
  signal: number;
  timestamp: number;
}

// Generic indicator result type
export type IndicatorResult =
  | MFIResult
  | ATRResult
  | TCF2Result
  | KPSSResult
  | TDFIResult
  | DSSMOMResult;

// ============================================================================
// Signals
// ============================================================================

export type SignalType = 'LONG' | 'SHORT' | 'NONE';

export interface Signal {
  type: SignalType;
  timestamp: number;
  price: number;
  mfi: number;
  atr: number;
  indicator?: string;
  indicatorValue?: number;
}

export interface AssetSignal extends Signal {
  asset: string;
}

// ============================================================================
// Positions
// ============================================================================

export type LegType = 'TP' | 'RUNNER';

export interface PositionLeg {
  id: string;
  type: LegType;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  targetPrice?: number;      // TP leg only
  trailingStop?: number;     // RUNNER leg only
  highestPrice?: number;     // RUNNER leg tracking
  status: 'OPEN' | 'CLOSED';
  closePrice?: number;
  closeTime?: number;
  closeReason?: string;
  asset?: string;            // For multi-asset bots
}

export interface AssetPositions {
  asset: string;
  openLegs: PositionLeg[];
  lastSignalTime: number;
  lastTradeTime: number;
}

// ============================================================================
// Bot State
// ============================================================================

export interface BotState {
  lastProcessedCandleTime: number;
  lastTradeTime: number;
  openLegs: PositionLeg[];
  totalTradesToday: number;
  lastDayReset: string;      // ISO date string
}

export interface MultiAssetBotState {
  lastProcessedCandleTime: number;
  lastDayReset: string;
  assetPositions: AssetPositions[];
}

// ============================================================================
// Configuration
// ============================================================================

export interface AssetConfig {
  symbol: string;
  name: string;
  binanceSymbol: string;
  solanaMint?: string;
  tradeLegUsdc: number;
  enabled: boolean;
}

export interface IndicatorConfig {
  type: 'mfi' | 'tcf2' | 'kpss' | 'tdfi' | 'dssmom';
  params: Record<string, number>;
}

export interface PositionConfig {
  tradeLegUsdc: number;
  atrTpMultiplier: number;
  atrTrailMultiplier: number;
  breakEvenLockMultiplier: number;
}

export interface RiskConfig {
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  maxPositionsPerAsset?: number;
  maxTotalPositions?: number;
  minTimeBetweenTradesMs?: number;
}

export interface ContinuousModeConfig {
  enabled: boolean;
  executionOffsetMinutes: number;
  checkIntervalMinutes: number;
}

export interface BotConfig {
  botId: string;
  timeframe: '1h' | '4h' | '1d';
  paperMode: boolean;
  liveTradingEnabled: boolean;

  indicator: IndicatorConfig;
  position: PositionConfig;
  risk: RiskConfig;

  assets?: AssetConfig[];
  continuous?: ContinuousModeConfig;

  // File paths (optional, can be derived)
  stateFile?: string;
  logFile?: string;
  errorLogFile?: string;
  csvDir?: string;
}

export interface PlatformConfig {
  // Solana RPC
  solanaRpcUrl: string;
  solanaRpcBackup?: string;

  // Wallet
  walletSecretKey: string;

  // Token mints
  tokens: {
    usdc: string;
    cbBtc?: string;
    wbtc?: string;
  };

  // Execution settings
  slippageBps?: number;          // default: 50
  maxPriceImpactBps?: number;    // default: 100

  // Data source
  candleSource?: string;         // default: 'binance'
}

// ============================================================================
// Execution / Trading
// ============================================================================

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  route: unknown;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  error?: string;
  inputAmount: number;
  outputAmount: number;
  executionPrice: number;
}

export interface BalanceInfo {
  usdc: number;
  btc: number;
  canTrade: boolean;
  reason?: string;
}

export interface TradeResult {
  success: boolean;
  legs?: PositionLeg[];
  error?: string;
  swapResult?: SwapResult;
}

// ============================================================================
// Dashboard / API
// ============================================================================

export interface BotRegistryEntry {
  id: string;
  name: string;
  indicator: string;
  timeframe: string;
  stateFile: string;
  logFile: string;
  serviceName: string;
  csvDir?: string;
}

export interface DashboardConfig {
  port: number;
  botsFile: string;
  stateDir: string;
  logsDir: string;
  csvDir: string;
  jwtSecret: string;
  adminPasswordHash: string;
  corsOrigins: string[];
  servicePrefix?: string;
}

// ============================================================================
// Logger Interface
// ============================================================================

export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
}
