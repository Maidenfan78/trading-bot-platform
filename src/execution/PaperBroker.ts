import { Signal, PositionLeg, Candle, Logger } from '../types';
import { Broker, PaperAccount, PaperBrokerConfig, PaperTradeExecution } from '../core/Broker';
import { createTwoLegPosition, updatePositions, closeRunnersOnTrimSignal } from '../strategy/position';

/**
 * Paper Trading Broker
 *
 * Simulates trade execution without using real money.
 * Fills are simulated at candle close prices with configurable slippage.
 *
 * This allows testing the strategy on historical data or live data
 * before risking real capital.
 */

export class PaperBroker implements Broker {
  private account: PaperAccount;
  private config: PaperBrokerConfig;
  private tradeHistory: PaperTradeExecution[] = [];
  private logger?: Logger;

  constructor(config: PaperBrokerConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
    this.account = {
      usdcBalance: config.initialUsdcBalance,
      btcBalance: config.initialBtcBalance,
      initialCapital: config.initialUsdcBalance,
      totalDeposited: config.initialUsdcBalance,
      totalWithdrawn: 0,
    };

    this.logger?.info('Paper broker initialized:', {
      usdcBalance: this.account.usdcBalance,
      btcBalance: this.account.btcBalance,
      slippageBps: this.config.slippageBps,
    });
  }

  /**
   * Get current account balances
   */
  getAccount(): PaperAccount {
    return { ...this.account };
  }

  /**
   * Get trade history
   */
  getTradeHistory(): PaperTradeExecution[] {
    return [...this.tradeHistory];
  }

  /**
   * Calculate total portfolio value in USDC
   */
  async getPortfolioValue(currentBtcPrice: number): Promise<number> {
    const btcValueInUsdc = this.account.btcBalance * currentBtcPrice;
    return this.account.usdcBalance + btcValueInUsdc;
  }

  /**
   * Calculate returns
   */
  async getReturns(currentBtcPrice: number): Promise<{
    portfolioValue: number;
    totalReturn: number;
    totalReturnPct: number;
  }> {
    const portfolioValue = await this.getPortfolioValue(currentBtcPrice);
    const totalReturn = portfolioValue - this.account.initialCapital;
    const totalReturnPct = (totalReturn / this.account.initialCapital) * 100;

    return {
      portfolioValue,
      totalReturn,
      totalReturnPct,
    };
  }

  /**
   * Apply slippage to price
   * For buys: price increases (worse fill)
   * For sells: price decreases (worse fill)
   */
  private applySlippage(price: number, isBuy: boolean): number {
    const slippageFactor = this.config.slippageBps / 10000;

    if (isBuy) {
      return price * (1 + slippageFactor); // Pay more
    } else {
      return price * (1 - slippageFactor); // Receive less
    }
  }

  /**
   * Simulate opening a two-leg position
   */
  async openPosition(signal: Signal, candle: Candle): Promise<PositionLeg[] | null> {
    if (signal.type !== 'LONG') {
      this.logger?.warn('Cannot open position on non-LONG signal');
      return null;
    }

    const totalCost = this.config.tradeLegUsdc * 2; // Two legs

    // Check if we have enough USDC
    if (this.account.usdcBalance < totalCost) {
      this.logger?.warn('Insufficient USDC balance for position:', {
        required: totalCost,
        available: this.account.usdcBalance,
      });
      return null;
    }

    // Apply slippage (buying BTC)
    const fillPrice = this.applySlippage(candle.close, true);

    // Create positions
    const legs = createTwoLegPosition(
      { ...signal, price: fillPrice },
      this.config.tradeLegUsdc,
      this.config.atrTpMultiplier ?? 1.0,
      this.config.atrTrailMultiplier ?? 2.5,
      this.logger
    );

    // Calculate total BTC bought
    const totalBtc = legs.reduce((sum, leg) => sum + leg.quantity, 0);

    // Update balances
    this.account.usdcBalance -= totalCost;
    this.account.btcBalance += totalBtc;

    // Record trade
    const execution: PaperTradeExecution = {
      timestamp: candle.timestamp,
      signal,
      action: 'OPEN_POSITION',
      price: fillPrice,
      usdcAmount: -totalCost,
      btcAmount: totalBtc,
      slippage: fillPrice - candle.close,
      legs,
    };
    this.tradeHistory.push(execution);

    this.logger?.info('Paper position opened:', {
      fillPrice: fillPrice.toFixed(2),
      slippage: (fillPrice - candle.close).toFixed(2),
      usdcSpent: totalCost,
      btcBought: totalBtc.toFixed(8),
      newUsdcBalance: this.account.usdcBalance.toFixed(2),
      newBtcBalance: this.account.btcBalance.toFixed(8),
    });

    return legs;
  }

  /**
   * Simulate closing a position leg
   */
  async closeLeg(leg: PositionLeg, candle: Candle, reason: string): Promise<void> {
    if (leg.status === 'CLOSED') {
      this.logger?.warn('Attempted to close already-closed leg:', leg.id);
      return;
    }

    // Apply slippage (selling BTC)
    const fillPrice = this.applySlippage(candle.close, false);

    // Calculate USDC received
    const usdcReceived = leg.quantity * fillPrice;

    // Update balances
    this.account.btcBalance -= leg.quantity;
    this.account.usdcBalance += usdcReceived;

    // Calculate P&L
    const profit = (fillPrice - leg.entryPrice) * leg.quantity;
    const profitPct = ((fillPrice - leg.entryPrice) / leg.entryPrice) * 100;

    // Record trade
    const execution: PaperTradeExecution = {
      timestamp: candle.timestamp,
      signal: {
        type: 'NONE',
        timestamp: candle.timestamp,
        mfi: 0,
        atr: 0,
        price: fillPrice,
      },
      action: leg.type === 'TP' ? 'CLOSE_TP' : 'CLOSE_RUNNER',
      price: fillPrice,
      usdcAmount: usdcReceived,
      btcAmount: -leg.quantity,
      slippage: candle.close - fillPrice,
    };
    this.tradeHistory.push(execution);

    this.logger?.info(`Paper ${leg.type} leg closed:`, {
      reason,
      entry: leg.entryPrice.toFixed(2),
      exit: fillPrice.toFixed(2),
      slippage: (candle.close - fillPrice).toFixed(2),
      profit: profit.toFixed(4),
      profitPct: profitPct.toFixed(2) + '%',
      usdcReceived: usdcReceived.toFixed(2),
      newUsdcBalance: this.account.usdcBalance.toFixed(2),
      newBtcBalance: this.account.btcBalance.toFixed(8),
    });
  }

  /**
   * Update positions and close any that hit targets/stops
   */
  async updateAndClosePositions(
    legs: PositionLeg[],
    candle: Candle,
    currentATR: number
  ): Promise<PositionLeg[]> {
    // Update positions (calculates stops, checks targets)
    const updatedLegs = updatePositions(
      legs,
      candle.close,
      currentATR,
      this.config.atrTrailMultiplier ?? 2.5,
      this.config.breakEvenLockMultiplier ?? 0.25,
      this.logger
    );

    // Close any legs that were marked CLOSED
    for (let i = 0; i < updatedLegs.length; i++) {
      const leg = updatedLegs[i];
      const wasOpen = legs[i].status === 'OPEN';
      const nowClosed = leg.status === 'CLOSED';

      if (wasOpen && nowClosed) {
        await this.closeLeg(leg, candle, leg.closeReason || 'Unknown');
      }
    }

    return updatedLegs;
  }

  /**
   * Close all runner legs on trim signal
   */
  async trimRunners(legs: PositionLeg[], signal: Signal, candle: Candle): Promise<PositionLeg[]> {
    if (signal.type !== 'SHORT') {
      return legs;
    }

    const beforeTrim = legs.filter((l) => l.type === 'RUNNER' && l.status === 'OPEN').length;

    // Mark runners as closed
    const trimmedLegs = closeRunnersOnTrimSignal(legs, signal, this.logger);

    // Execute the closes
    for (let i = 0; i < trimmedLegs.length; i++) {
      const leg = trimmedLegs[i];
      const wasOpen = legs[i].status === 'OPEN';
      const nowClosed = leg.status === 'CLOSED';

      if (wasOpen && nowClosed && leg.type === 'RUNNER') {
        await this.closeLeg(leg, candle, 'Trim signal (MFI < 70)');
      }
    }

    const afterTrim = trimmedLegs.filter((l) => l.type === 'RUNNER' && l.status === 'OPEN').length;

    if (beforeTrim > afterTrim) {
      this.logger?.info(`Trimmed ${beforeTrim - afterTrim} runner legs`);
    }

    return trimmedLegs;
  }

  /**
   * Get account summary for logging
   */
  async getSummary(currentBtcPrice: number): Promise<string> {
    const returns = await this.getReturns(currentBtcPrice);

    return `
Paper Account Summary:
  USDC Balance: $${this.account.usdcBalance.toFixed(2)}
  BTC Balance: ${this.account.btcBalance.toFixed(8)} BTC ($${(this.account.btcBalance * currentBtcPrice).toFixed(2)})
  Portfolio Value: $${returns.portfolioValue.toFixed(2)}
  Total Return: $${returns.totalReturn.toFixed(2)} (${returns.totalReturnPct.toFixed(2)}%)
  Trades Executed: ${this.tradeHistory.length}
    `.trim();
  }
}
