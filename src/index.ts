/**
 * Trading Bot Platform
 *
 * A multi-indicator, multi-asset trading bot framework for Solana.
 *
 * @module trading-bot-platform
 */

// ============================================================================
// Types
// ============================================================================

export * from './types';

// ============================================================================
// Core Abstractions
// ============================================================================

export {
  // Logger
  createLogger,
  createConsoleLogger,
  createNullLogger,

  // State Management
  StateManager,
} from './core';

export type {
  LoggerConfig,
  Broker,
  PaperAccount,
  PaperTradeExecution as CorePaperTradeExecution,
  PaperBrokerConfig,
  LiveBrokerConfig,
} from './core';

// ============================================================================
// Indicators
// ============================================================================

export {
  // MFI
  typicalPrice,
  calculateMFI,
  calculateMFIWithMetadata,
  calculateMFISeries,
  detectMFICross,

  // ATR
  calculateTrueRange,
  calculateATR,
  calculateATRWithMetadata,
  calculateATRSeries,
  calculateATRLevels,
  updateTrailingStop,
  isValidATR,

  // TCF2
  initTCF2State,
  calculateTCF2Series,
  getTCF2Signal,
  calculateTCF2WithSignal,

  // KPSS
  calculateKPSSSeries,
  getKPSSSignal,
  calculateKPSSWithSignal,

  // TDFI
  calculateTDFISeries,
  getTDFISignal,
  calculateTDFIWithSignal,

  // DSS-MOM
  calculateDSSMOMSeries,
  getDSSMOMSignal,
  calculateDSSMOMWithSignal,

  // Registry
  INDICATORS,
} from './indicators';

export type { TCF2State, IndicatorName } from './indicators';

// ============================================================================
// Strategy
// ============================================================================

export {
  // Signal detection
  detectMFICrossSignal,
  generateSignal,
  isValidSignal,

  // Position management
  createTwoLegPosition,
  updatePositions,
  getOpenLegs,
  getClosedLegs,
  closeRunnersOnTrimSignal,
  calculateUnrealizedPnL,
  calculateRealizedPnL,
  getPositionSummary,
} from './strategy';

// ============================================================================
// Utils
// ============================================================================

export {
  // Environment
  loadEnvConfig,
  getRequiredEnv,
  getOptionalEnv,
  getNumericEnv,
  getBooleanEnv,

  // CSV Logging
  createCSVLogger,
  createTradingCSVLogger,
} from './utils';

export type {
  CSVLoggerConfig,
  CSVLogger,
  PaperTradeExecution,
  EquitySnapshot,
  TradingCSVLoggerConfig,
  TradingCSVLogger,
  TradeEntry,
  TradeExit,
  DailySummary,
} from './utils';

// ============================================================================
// Solana / Jupiter
// ============================================================================

export {
  // Jupiter DEX
  JupiterClient,
  getExecutionPrice,

  // Wallet & Transactions
  loadWallet,
  sendAndConfirmVersionedTransaction,
  simulateVersionedTransaction,
  getRecentBlockhash,
  checkRPCHealth,
  parseTransactionError,

  // Balance Management
  getTokenBalance,
  getAllBalances,
  canTrade,
  canClosePosition,
  getBalanceSummary,
} from './solana';

export type { JupiterConfig, BalanceConfig } from './solana';

// ============================================================================
// Execution / Brokers
// ============================================================================

export {
  PaperBroker,
  LiveBroker,
  CircuitBreaker,
} from './execution';

export type {
  CircuitBreakerConfig,
  CircuitBreakerState,
} from './execution';

// ============================================================================
// Data Fetching
// ============================================================================

export {
  BinanceFetcher,
  isValidCandle,
  validateCandleArray,
  createBTCDailyFetcher,
  createBTC4HFetcher,
  createBTC1HFetcher,
} from './data';

export type {
  BinanceFetcherConfig,
  BinanceInterval,
} from './data';

// ============================================================================
// Multi-Asset Trading
// ============================================================================

export {
  initializeMultiAssetState,
  getAssetPositions,
  updateAssetPositions,
  getTotalOpenPositions,
  getTotalOpenAssets,
  canAssetTrade,
  recordAssetTrade,
  getMultiAssetSummary,
  filterTradableSignals,
  getEnabledAssets,
  getAsset,
  getTotalCapitalPerSignal,
} from './multi-asset';

export type { MultiAssetManagerConfig } from './multi-asset';

// ============================================================================
// Journal
// ============================================================================

export {
  EventStore,
  JournalEmitter,
} from './journal';

export type {
  JournalEvent,
  JournalEventType,
  JournalEventCategory,
  JournalEventPayload,
  MarketContext,
  TrendDirection,
  VolatilityLevel,
  EventQueryFilters,
  EventQueryResult,
  EventStoreConfig,
  JournalEmitterConfig,
  // Payload types
  CycleStartPayload,
  CycleEndPayload,
  SignalGeneratedPayload,
  SignalRejectedPayload,
  NoSignalPayload,
  PositionOpenedPayload,
  TpHitPayload,
  TrailingStopUpdatedPayload,
  TrailingStopHitPayload,
  RunnerTrimmedPayload,
  TradeFailedPayload,
  ErrorPayload,
} from './journal';

// ============================================================================
// Dashboard (optional - import from 'trading-bot-platform/dashboard')
// ============================================================================

// Dashboard is exported as a separate entry point to avoid pulling in
// Express and Socket.IO dependencies when only using the core platform.
// Use: import { createDashboardApp } from 'trading-bot-platform/dashboard';
