/**
 * Journal Event Types
 *
 * Comprehensive event-based journaling for forward testing.
 * Every signal, decision, rejection, and execution is captured
 * with full market context.
 */

// ============================================================================
// Event Categories & Types
// ============================================================================

export type JournalEventCategory =
  | 'CYCLE' // Bot execution lifecycle
  | 'SIGNAL' // Signal generation & filtering
  | 'POSITION' // Position lifecycle
  | 'EXECUTION' // Trade execution
  | 'SYSTEM'; // Errors, state changes

export type JournalEventType =
  // Cycle events
  | 'CYCLE_START'
  | 'CYCLE_END'
  // Signal events
  | 'SIGNAL_GENERATED'
  | 'SIGNAL_REJECTED'
  | 'NO_SIGNAL'
  // Position events
  | 'POSITION_OPENED'
  | 'POSITION_UPDATED'
  | 'TP_HIT'
  | 'TRAILING_STOP_UPDATED'
  | 'TRAILING_STOP_HIT'
  | 'RUNNER_TRIMMED'
  | 'BREAKEVEN_LOCK_ACTIVATED'
  // Execution events
  | 'TRADE_EXECUTED'
  | 'TRADE_FAILED'
  | 'INSUFFICIENT_BALANCE'
  // System events
  | 'ERROR'
  | 'STATE_LOADED'
  | 'STATE_SAVED';

// ============================================================================
// Market Context
// ============================================================================

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type VolatilityLevel = 'LOW' | 'NORMAL' | 'HIGH';

/**
 * Market state captured at the moment of an event.
 * Provides full context for analyzing decisions later.
 */
export interface MarketContext {
  /** Current price */
  price: number;
  /** Primary indicator value (e.g., MFI) */
  indicator: number;
  /** Indicator name for display */
  indicatorName: string;
  /** ATR value */
  atr: number;
  /** ATR as percentage of price */
  atrPercent: number;
  /** Market trend based on indicator levels */
  trend: TrendDirection;
  /** Volatility assessment based on ATR */
  volatility: VolatilityLevel;
  /** Timestamp of the candle being processed */
  candleTime: number;
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface CycleStartPayload {
  assetsToProcess: string[];
  totalOpenPositions: number;
}

export interface CycleEndPayload {
  assetsProcessed: number;
  signalsGenerated: number;
  positionsOpened: number;
  positionsClosed: number;
  runnersTrimmed: number;
  cycleDurationMs: number;
}

export interface SignalGeneratedPayload {
  signalType: 'LONG' | 'SHORT';
  previousIndicator: number;
  currentIndicator: number;
  buyLevel: number;
  sellLevel: number;
  crossDirection: 'UP' | 'DOWN';
}

export interface SignalRejectedPayload {
  signalType: 'LONG' | 'SHORT';
  reason: string;
  details?: {
    currentPositions?: number;
    maxPositions?: number;
    cooldownRemainingMs?: number;
    lastTradeTime?: number;
  };
}

export interface NoSignalPayload {
  indicatorValue: number;
  buyLevel: number;
  sellLevel: number;
  reason: string; // e.g., "MFI between levels", "No crossover"
}

export interface PositionOpenedPayload {
  legIds: string[];
  entryPrice: number;
  fillPrice: number;
  slippageUsdc: number;
  totalUsdc: number;
  totalQuantity: number;
  tpTarget: number;
  breakevenLock: number;
  atrUsed: number;
}

export interface TpHitPayload {
  legId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsdc: number;
  pnlPercent: number;
  holdingPeriodMs: number;
}

export interface TrailingStopUpdatedPayload {
  legId: string;
  previousStop: number | null;
  newStop: number;
  previousHighest: number;
  newHighest: number;
  reason: 'ACTIVATED' | 'NEW_HIGH';
}

export interface TrailingStopHitPayload {
  legId: string;
  entryPrice: number;
  exitPrice: number;
  highestReached: number;
  quantity: number;
  pnlUsdc: number;
  pnlPercent: number;
  holdingPeriodMs: number;
}

export interface RunnerTrimmedPayload {
  legId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsdc: number;
  pnlPercent: number;
  holdingPeriodMs: number;
  triggerIndicator: number;
  triggerLevel: number;
}

export interface TradeFailedPayload {
  reason: string;
  requiredUsdc?: number;
  availableUsdc?: number;
  signalType: 'LONG' | 'SHORT';
}

export interface ErrorPayload {
  message: string;
  stack?: string;
  context?: string;
}

export type JournalEventPayload =
  | CycleStartPayload
  | CycleEndPayload
  | SignalGeneratedPayload
  | SignalRejectedPayload
  | NoSignalPayload
  | PositionOpenedPayload
  | TpHitPayload
  | TrailingStopUpdatedPayload
  | TrailingStopHitPayload
  | RunnerTrimmedPayload
  | TradeFailedPayload
  | ErrorPayload
  | Record<string, unknown>; // Allow flexible payloads

// ============================================================================
// Core Event Interface
// ============================================================================

/**
 * A single journal event capturing a moment in the trading bot's execution.
 */
export interface JournalEvent {
  /** Unique event identifier */
  id: string;
  /** Event creation timestamp (ms since epoch) */
  timestamp: number;
  /** Bot that generated this event */
  botId: string;
  /** Asset symbol (e.g., 'wETH', 'SOL') */
  asset: string;
  /** High-level category */
  category: JournalEventCategory;
  /** Specific event type */
  type: JournalEventType;
  /** Market state at event time */
  market: MarketContext;
  /** Event-specific data */
  payload: JournalEventPayload;
  /** Links events from same bot execution cycle */
  cycleId?: string;
  /** Links events related to same position */
  positionId?: string;
  /** Links events related to same signal */
  signalId?: string;
  /** Trading mode */
  mode: 'PAPER' | 'LIVE';
}

// ============================================================================
// Query & Filter Types
// ============================================================================

export interface EventQueryFilters {
  botId?: string;
  asset?: string;
  category?: JournalEventCategory;
  types?: JournalEventType[];
  startTime?: number;
  endTime?: number;
  cycleId?: string;
  positionId?: string;
  signalId?: string;
  mode?: 'PAPER' | 'LIVE';
  limit?: number;
  offset?: number;
}

export interface EventQueryResult {
  events: JournalEvent[];
  total: number;
  hasMore: boolean;
}

// ============================================================================
// Storage Types
// ============================================================================

export interface EventDatabase {
  version: number;
  events: JournalEvent[];
  lastUpdated: number;
}

export interface EventStoreConfig {
  /** Directory for event data files */
  dataDir: string;
  /** Max events to keep in memory (default: 10000) */
  maxEventsInMemory?: number;
  /** Archive events older than this many days (default: 30) */
  archiveAfterDays?: number;
  /** Flush to disk after this many events (default: 10) */
  flushThreshold?: number;
}
