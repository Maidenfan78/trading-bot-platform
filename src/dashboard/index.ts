/**
 * Dashboard Module
 *
 * Provides a configurable Express + Socket.IO dashboard for trading bots.
 */

// Main factory function
export { createDashboardApp, type DashboardApp } from './createDashboardApp';

// Types
export type {
  DashboardConfig,
  BotConfig,
  BotState,
  MultiAssetBotState,
  AssetPositions,
  PositionLeg,
  CircuitBreakerState,
  BotStatusResponse,
  StatusResponse,
  PositionsResponse,
  TradeEntry,
  TradesResponse,
  PerformanceMetrics,
  EquityPoint,
  PerformanceResponse,
  LogEntry,
  LogsResponse,
  ControlResponse,
  WebSocketMessage,
  StateUpdateEvent,
  LogEntryEvent,
  TradeTag,
  JournalEntry,
  ServiceStatus,
  IndicatorOption,
} from './types';

export { INDICATORS, TIMEFRAMES } from './types';

// Services
export {
  StateWatcher,
  SystemctlService,
  CSVReader,
  LogTailer,
  JournalDbService,
  PriceProvider,
  HyperliquidPriceProvider,
  StaticPriceProvider,
  getDefaultPriceProvider,
  setDefaultPriceProvider,
  getCurrentPrices,
  normalizeAssetName,
  getAssetPrice,
} from './services';

// Middleware
export {
  createVerifyToken,
  createLogin,
  hashPassword,
  rateLimitLogin,
  resetRateLimit,
  createErrorHandler,
  notFoundHandler,
  asyncHandler,
  type JWTPayload,
} from './middleware';
