/**
 * JournalEmitter - Helper class for bots to emit journal events
 *
 * Provides a clean, declarative API for capturing events at decision points.
 * Handles ID generation, timestamps, and optional persistence.
 */

import { randomUUID } from 'crypto';
import {
  JournalEvent,
  JournalEventType,
  JournalEventCategory,
  JournalEventPayload,
  MarketContext,
  TrendDirection,
  VolatilityLevel,
} from './types.js';
import { EventStore } from './EventStore.js';

export interface JournalEmitterConfig {
  botId: string;
  mode: 'PAPER' | 'LIVE';
  /** EventStore instance for persistence. If null, events are not persisted. */
  eventStore?: EventStore | null;
  /** Callback for real-time event broadcast (e.g., WebSocket) */
  onEvent?: (event: JournalEvent) => void;
}

const EVENT_CATEGORIES: Record<JournalEventType, JournalEventCategory> = {
  CYCLE_START: 'CYCLE',
  CYCLE_END: 'CYCLE',
  SIGNAL_GENERATED: 'SIGNAL',
  SIGNAL_REJECTED: 'SIGNAL',
  NO_SIGNAL: 'SIGNAL',
  POSITION_OPENED: 'POSITION',
  POSITION_UPDATED: 'POSITION',
  TP_HIT: 'POSITION',
  TRAILING_STOP_UPDATED: 'POSITION',
  TRAILING_STOP_HIT: 'POSITION',
  RUNNER_TRIMMED: 'POSITION',
  BREAKEVEN_LOCK_ACTIVATED: 'POSITION',
  TRADE_EXECUTED: 'EXECUTION',
  TRADE_FAILED: 'EXECUTION',
  INSUFFICIENT_BALANCE: 'EXECUTION',
  ERROR: 'SYSTEM',
  STATE_LOADED: 'SYSTEM',
  STATE_SAVED: 'SYSTEM',
};

export class JournalEmitter {
  private config: JournalEmitterConfig;
  private currentCycleId: string | null = null;
  private cycleEvents: JournalEvent[] = [];

  constructor(config: JournalEmitterConfig) {
    this.config = config;
  }

  /**
   * Start a new execution cycle. All events until endCycle() will be linked.
   */
  startCycle(): string {
    this.currentCycleId = randomUUID();
    this.cycleEvents = [];
    return this.currentCycleId;
  }

  /**
   * End the current cycle and flush events.
   */
  endCycle(): void {
    if (this.config.eventStore && this.cycleEvents.length > 0) {
      this.config.eventStore.flush();
    }
    this.currentCycleId = null;
    this.cycleEvents = [];
  }

  /**
   * Get the current cycle ID (for linking events externally)
   */
  getCycleId(): string | null {
    return this.currentCycleId;
  }

  /**
   * Emit a journal event
   */
  emit(
    type: JournalEventType,
    options: {
      asset: string;
      market: MarketContext;
      payload: JournalEventPayload;
      positionId?: string;
      signalId?: string;
    }
  ): JournalEvent {
    const event: JournalEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      botId: this.config.botId,
      asset: options.asset,
      category: EVENT_CATEGORIES[type],
      type,
      market: options.market,
      payload: options.payload,
      cycleId: this.currentCycleId || undefined,
      positionId: options.positionId,
      signalId: options.signalId,
      mode: this.config.mode,
    };

    // Track in cycle
    this.cycleEvents.push(event);

    // Persist if store available
    if (this.config.eventStore) {
      this.config.eventStore.append(event);
    }

    // Broadcast if callback available
    if (this.config.onEvent) {
      this.config.onEvent(event);
    }

    return event;
  }

  /**
   * Helper to create market context from candle and indicator data
   */
  static createMarketContext(options: {
    price: number;
    indicator: number;
    indicatorName: string;
    atr: number;
    candleTime: number;
    buyLevel?: number;
    sellLevel?: number;
  }): MarketContext {
    const { price, indicator, indicatorName, atr, candleTime, buyLevel, sellLevel } =
      options;

    // Determine trend based on indicator levels
    let trend: TrendDirection = 'NEUTRAL';
    if (buyLevel !== undefined && sellLevel !== undefined) {
      if (indicator <= buyLevel) {
        trend = 'BEARISH'; // Oversold territory
      } else if (indicator >= sellLevel) {
        trend = 'BULLISH'; // Overbought territory
      }
    }

    // Determine volatility based on ATR percentage
    const atrPercent = (atr / price) * 100;
    let volatility: VolatilityLevel = 'NORMAL';
    if (atrPercent < 1.5) {
      volatility = 'LOW';
    } else if (atrPercent > 4) {
      volatility = 'HIGH';
    }

    return {
      price,
      indicator,
      indicatorName,
      atr,
      atrPercent,
      trend,
      volatility,
      candleTime,
    };
  }

  // =========================================================================
  // Convenience methods for common event types
  // =========================================================================

  /**
   * Emit CYCLE_START event
   */
  cycleStart(
    market: MarketContext,
    payload: { assetsToProcess: string[]; totalOpenPositions: number }
  ): JournalEvent {
    return this.emit('CYCLE_START', {
      asset: '*', // Cycle-level event
      market,
      payload,
    });
  }

  /**
   * Emit CYCLE_END event
   */
  cycleEnd(
    market: MarketContext,
    payload: {
      assetsProcessed: number;
      signalsGenerated: number;
      positionsOpened: number;
      positionsClosed: number;
      runnersTrimmed: number;
      cycleDurationMs: number;
    }
  ): JournalEvent {
    return this.emit('CYCLE_END', {
      asset: '*',
      market,
      payload,
    });
  }

  /**
   * Emit SIGNAL_GENERATED event
   */
  signalGenerated(
    asset: string,
    market: MarketContext,
    payload: {
      signalType: 'LONG' | 'SHORT';
      previousIndicator: number;
      currentIndicator: number;
      buyLevel: number;
      sellLevel: number;
      crossDirection: 'UP' | 'DOWN';
    },
    signalId?: string
  ): JournalEvent {
    return this.emit('SIGNAL_GENERATED', {
      asset,
      market,
      payload,
      signalId,
    });
  }

  /**
   * Emit SIGNAL_REJECTED event
   */
  signalRejected(
    asset: string,
    market: MarketContext,
    payload: {
      signalType: 'LONG' | 'SHORT';
      reason: string;
      details?: {
        currentPositions?: number;
        maxPositions?: number;
        cooldownRemainingMs?: number;
        lastTradeTime?: number;
      };
    },
    signalId?: string
  ): JournalEvent {
    return this.emit('SIGNAL_REJECTED', {
      asset,
      market,
      payload,
      signalId,
    });
  }

  /**
   * Emit NO_SIGNAL event
   */
  noSignal(
    asset: string,
    market: MarketContext,
    payload: {
      indicatorValue: number;
      buyLevel: number;
      sellLevel: number;
      reason: string;
    }
  ): JournalEvent {
    return this.emit('NO_SIGNAL', {
      asset,
      market,
      payload,
    });
  }

  /**
   * Emit POSITION_OPENED event
   */
  positionOpened(
    asset: string,
    market: MarketContext,
    payload: {
      legIds: string[];
      entryPrice: number;
      fillPrice: number;
      slippageUsdc: number;
      totalUsdc: number;
      totalQuantity: number;
      tpTarget: number;
      breakevenLock: number;
      atrUsed: number;
    },
    positionId?: string,
    signalId?: string
  ): JournalEvent {
    return this.emit('POSITION_OPENED', {
      asset,
      market,
      payload,
      positionId,
      signalId,
    });
  }

  /**
   * Emit TP_HIT event
   */
  tpHit(
    asset: string,
    market: MarketContext,
    payload: {
      legId: string;
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      pnlUsdc: number;
      pnlPercent: number;
      holdingPeriodMs: number;
    },
    positionId?: string
  ): JournalEvent {
    return this.emit('TP_HIT', {
      asset,
      market,
      payload,
      positionId,
    });
  }

  /**
   * Emit TRAILING_STOP_UPDATED event
   */
  trailingStopUpdated(
    asset: string,
    market: MarketContext,
    payload: {
      legId: string;
      previousStop: number | null;
      newStop: number;
      previousHighest: number;
      newHighest: number;
      reason: 'ACTIVATED' | 'NEW_HIGH';
    },
    positionId?: string
  ): JournalEvent {
    return this.emit('TRAILING_STOP_UPDATED', {
      asset,
      market,
      payload,
      positionId,
    });
  }

  /**
   * Emit TRAILING_STOP_HIT event
   */
  trailingStopHit(
    asset: string,
    market: MarketContext,
    payload: {
      legId: string;
      entryPrice: number;
      exitPrice: number;
      highestReached: number;
      quantity: number;
      pnlUsdc: number;
      pnlPercent: number;
      holdingPeriodMs: number;
    },
    positionId?: string
  ): JournalEvent {
    return this.emit('TRAILING_STOP_HIT', {
      asset,
      market,
      payload,
      positionId,
    });
  }

  /**
   * Emit RUNNER_TRIMMED event
   */
  runnerTrimmed(
    asset: string,
    market: MarketContext,
    payload: {
      legId: string;
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      pnlUsdc: number;
      pnlPercent: number;
      holdingPeriodMs: number;
      triggerIndicator: number;
      triggerLevel: number;
    },
    positionId?: string
  ): JournalEvent {
    return this.emit('RUNNER_TRIMMED', {
      asset,
      market,
      payload,
      positionId,
    });
  }

  /**
   * Emit TRADE_FAILED event
   */
  tradeFailed(
    asset: string,
    market: MarketContext,
    payload: {
      reason: string;
      requiredUsdc?: number;
      availableUsdc?: number;
      signalType: 'LONG' | 'SHORT';
    },
    signalId?: string
  ): JournalEvent {
    return this.emit('TRADE_FAILED', {
      asset,
      market,
      payload,
      signalId,
    });
  }

  /**
   * Emit ERROR event
   */
  error(
    asset: string,
    market: MarketContext,
    payload: {
      message: string;
      stack?: string;
      context?: string;
    }
  ): JournalEvent {
    return this.emit('ERROR', {
      asset,
      market,
      payload,
    });
  }
}
