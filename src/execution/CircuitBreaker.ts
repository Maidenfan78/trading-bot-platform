import { Logger } from '../types';

/**
 * Circuit Breaker
 *
 * Safety mechanism to halt trading when anomalies are detected.
 * Prevents runaway losses from bugs, API issues, or market anomalies.
 */

export interface CircuitBreakerConfig {
  maxDailyLossPct: number; // Max % loss in 24h before halting
  maxConsecutiveLosses: number; // Max consecutive losing trades
  maxDailyTrades: number; // Hard limit on trades per day
  minTimeBetweenTradesMs: number; // Cooldown between trades
  maxPriceDeviationPct: number; // Max % price deviation from expected
}

export interface CircuitBreakerState {
  dailyPnl: number;
  consecutiveLosses: number;
  tradesExecutedToday: number;
  lastTradeTimestamp: number;
  tripped: boolean;
  tripReason?: string;
  resetDate: string; // ISO date for daily reset
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;
  private logger?: Logger;

  constructor(config: CircuitBreakerConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
    this.state = {
      dailyPnl: 0,
      consecutiveLosses: 0,
      tradesExecutedToday: 0,
      lastTradeTimestamp: 0,
      tripped: false,
      resetDate: new Date().toISOString().split('T')[0],
    };

    this.logger?.info('Circuit breaker initialized', {
      maxDailyLossPct: config.maxDailyLossPct,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
      maxDailyTrades: config.maxDailyTrades,
    });
  }

  /**
   * Reset daily counters (call at start of new day)
   */
  resetDaily(): void {
    const today = new Date().toISOString().split('T')[0];

    if (today !== this.state.resetDate) {
      this.logger?.info('Resetting daily circuit breaker counters');

      this.state.dailyPnl = 0;
      this.state.tradesExecutedToday = 0;
      this.state.resetDate = today;

      // Don't reset consecutiveLosses - carries over
      // Don't reset tripped state - must be manually reset
    }
  }

  /**
   * Check if trading is allowed
   */
  canTrade(): { allowed: boolean; reason?: string } {
    // Reset daily if needed
    this.resetDaily();

    // Check if already tripped
    if (this.state.tripped) {
      return {
        allowed: false,
        reason: `Circuit breaker tripped: ${this.state.tripReason}`,
      };
    }

    // Check daily trade limit
    if (this.state.tradesExecutedToday >= this.config.maxDailyTrades) {
      return {
        allowed: false,
        reason: `Daily trade limit reached (${this.config.maxDailyTrades})`,
      };
    }

    // Check cooldown period
    const now = Date.now();
    const timeSinceLastTrade = now - this.state.lastTradeTimestamp;

    if (
      this.state.lastTradeTimestamp > 0 &&
      timeSinceLastTrade < this.config.minTimeBetweenTradesMs
    ) {
      const remainingMs = this.config.minTimeBetweenTradesMs - timeSinceLastTrade;
      const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);

      return {
        allowed: false,
        reason: `Cooldown period active (${remainingHours}h remaining)`,
      };
    }

    // All checks passed
    return { allowed: true };
  }

  /**
   * Record a trade execution
   */
  recordTrade(pnl: number, currentPortfolioValue: number): void {
    const now = Date.now();

    this.state.tradesExecutedToday++;
    this.state.lastTradeTimestamp = now;
    this.state.dailyPnl += pnl;

    // Track consecutive losses
    if (pnl < 0) {
      this.state.consecutiveLosses++;
      this.logger?.warn(`Consecutive losses: ${this.state.consecutiveLosses}`, {
        pnl: pnl.toFixed(2),
      });
    } else {
      this.state.consecutiveLosses = 0;
    }

    this.logger?.info('Trade recorded in circuit breaker', {
      pnl: pnl.toFixed(2),
      dailyPnl: this.state.dailyPnl.toFixed(2),
      tradesExecutedToday: this.state.tradesExecutedToday,
      consecutiveLosses: this.state.consecutiveLosses,
    });

    // Check for circuit breaker conditions
    this.checkConditions(currentPortfolioValue);
  }

  /**
   * Check if circuit breaker should trip
   */
  private checkConditions(currentPortfolioValue: number): void {
    // Check daily loss limit
    const dailyLossPct = (this.state.dailyPnl / currentPortfolioValue) * 100;

    if (dailyLossPct < -this.config.maxDailyLossPct) {
      this.trip(
        `Daily loss limit exceeded: ${dailyLossPct.toFixed(2)}% (limit: -${this.config.maxDailyLossPct}%)`
      );
      return;
    }

    // Check consecutive losses
    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trip(
        `Consecutive loss limit exceeded: ${this.state.consecutiveLosses} losses (limit: ${this.config.maxConsecutiveLosses})`
      );
      return;
    }
  }

  /**
   * Validate price against expected value
   */
  validatePrice(
    currentPrice: number,
    expectedPrice: number
  ): { valid: boolean; reason?: string } {
    const deviationPct = Math.abs((currentPrice - expectedPrice) / expectedPrice) * 100;

    if (deviationPct > this.config.maxPriceDeviationPct) {
      const reason = `Price deviation too high: ${deviationPct.toFixed(2)}% (limit: ${this.config.maxPriceDeviationPct}%)`;
      this.logger?.error(reason, {
        currentPrice: currentPrice.toFixed(2),
        expectedPrice: expectedPrice.toFixed(2),
      });

      // Don't trip circuit breaker, just reject this trade
      return { valid: false, reason };
    }

    return { valid: true };
  }

  /**
   * Trip the circuit breaker
   */
  trip(reason: string): void {
    this.logger?.error('🚨 CIRCUIT BREAKER TRIPPED 🚨', { reason });

    this.state.tripped = true;
    this.state.tripReason = reason;

    // In a real system, send alerts here (email, SMS, Discord, etc.)
  }

  /**
   * Manually reset circuit breaker (requires human intervention)
   */
  reset(reason: string): void {
    this.logger?.warn('Circuit breaker manually reset', { reason });

    this.state.tripped = false;
    this.state.tripReason = undefined;
    this.state.consecutiveLosses = 0;
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Set state (for restoring from persistence)
   */
  setState(state: Partial<CircuitBreakerState>): void {
    this.state = { ...this.state, ...state };
  }

  /**
   * Get summary for logging
   */
  getSummary(): string {
    return `
Circuit Breaker Status:
  Status: ${this.state.tripped ? '🔴 TRIPPED' : '🟢 ACTIVE'}
  ${this.state.tripReason ? `Reason: ${this.state.tripReason}` : ''}
  Daily P&L: $${this.state.dailyPnl.toFixed(2)}
  Trades Today: ${this.state.tradesExecutedToday}/${this.config.maxDailyTrades}
  Consecutive Losses: ${this.state.consecutiveLosses}/${this.config.maxConsecutiveLosses}
  Last Trade: ${this.state.lastTradeTimestamp > 0 ? new Date(this.state.lastTradeTimestamp).toISOString() : 'Never'}
    `.trim();
  }
}
