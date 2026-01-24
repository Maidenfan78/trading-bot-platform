import type { PublicKey, Keypair } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';
import type { Signal, PositionLeg, Candle, SwapResult, Logger } from '../types';
import type { Broker, LiveBrokerConfig } from '../core/Broker';
import { JupiterClient } from '../solana/jupiter';
import { loadWallet, sendAndConfirmVersionedTransaction } from '../solana/wallet';
import type { BalanceConfig } from '../solana/balances';
import { canTrade, canClosePosition } from '../solana/balances';
import { createTwoLegPosition, updatePositions, closeRunnersOnTrimSignal } from '../strategy/position';

/**
 * Live Trading Broker
 *
 * Executes real trades on Solana via Jupiter DEX.
 * Handles wallet management, balance checks, and swap execution.
 */

export class LiveBroker implements Broker {
  private connection: Connection;
  private wallet: Keypair;
  private jupiterClient: JupiterClient;
  private config: LiveBrokerConfig;
  private logger?: Logger;

  constructor(config: LiveBrokerConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
    this.connection = new Connection(config.rpcUrl, 'confirmed');

    // Load wallet
    this.wallet = loadWallet(config.walletSecretKey, logger);

    // Initialize Jupiter client
    this.jupiterClient = new JupiterClient(
      {
        rpcUrl: config.rpcUrl,
        usdcMint: config.usdcMint,
        cbBtcMint: config.cbBtcMint,
        wbtcMint: config.wbtcMint,
        slippageBps: config.slippageBps,
        maxPriceImpactBps: config.maxPriceImpactBps,
      },
      logger
    );

    this.logger?.info('Live broker initialized', {
      wallet: this.wallet.publicKey.toBase58(),
      rpc: config.rpcUrl,
      tradeLegUsdc: config.tradeLegUsdc,
    });
  }

  /**
   * Get wallet public key
   */
  getWalletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Get balance configuration
   */
  private getBalanceConfig(): BalanceConfig {
    return {
      minBtcBalance: this.config.minBtcBalance,
      minUsdcReserve: this.config.minUsdcReserve,
    };
  }

  /**
   * Open a two-leg position with real BTC purchase
   */
  async openPosition(signal: Signal, candle: Candle): Promise<PositionLeg[] | null> {
    if (signal.type !== 'LONG') {
      this.logger?.warn('Cannot open position on non-LONG signal');
      return null;
    }

    try {
      this.logger?.info('🔄 Opening live position...', {
        signal: signal.type,
        price: candle.close.toFixed(2),
        mfi: signal.mfi.toFixed(2),
      });

      // 1. Check if we can trade
      const tradeCheck = await canTrade(
        this.connection,
        this.wallet.publicKey,
        this.config.usdcMint,
        this.config.cbBtcMint,
        this.config.wbtcMint,
        this.config.tradeLegUsdc,
        this.getBalanceConfig(),
        this.logger
      );

      if (!tradeCheck.canTrade) {
        this.logger?.error('Trade rejected - insufficient balance:', tradeCheck.reason);
        return null;
      }

      this.logger?.info('✓ Balance check passed', {
        usdcBalance: tradeCheck.usdc.toFixed(2),
        btcBalance: tradeCheck.btc.toFixed(8),
      });

      // 2. Get quote from Jupiter (tries cbBTC first, falls back to WBTC)
      const totalUsdc = this.config.tradeLegUsdc * 2; // Two legs
      const quoteResult = await this.jupiterClient.getQuoteUsdcToBtc(totalUsdc);

      if (!quoteResult) {
        this.logger?.error('Failed to get quote from Jupiter');
        return null;
      }

      const { quote, btcMint } = quoteResult;

      this.logger?.info('✓ Quote received', {
        inputUsdc: totalUsdc,
        outputBtc: (Number(quote.outAmount) / 1e8).toFixed(8),
        btcMint,
        priceImpact: quote.priceImpactPct + '%',
      });

      // 3. Validate quote before execution
      const isQuoteValid = await this.jupiterClient.validateQuote(quote, 2.0); // Max 2% degradation

      if (!isQuoteValid) {
        this.logger?.error('Quote validation failed - price degraded too much');
        return null;
      }

      this.logger?.info('✓ Quote validated');

      // 4. Build swap transaction
      const transaction = await this.jupiterClient.buildSwapTransaction(
        quote,
        this.wallet.publicKey
      );

      if (!transaction) {
        this.logger?.error('Failed to build swap transaction');
        return null;
      }

      this.logger?.info('✓ Swap transaction built');

      // 5. Execute swap
      this.logger?.info('📤 Sending transaction to Solana...');

      const result = await sendAndConfirmVersionedTransaction(
        this.connection,
        transaction,
        this.wallet,
        {
          maxRetries: 3,
          skipPreflight: false,
        },
        this.logger
      );

      if (!result.success) {
        this.logger?.error('Swap transaction failed:', result.error);
        return null;
      }

      this.logger?.info('✅ Swap executed successfully!', {
        signature: result.signature,
        explorer: `https://solscan.io/tx/${result.signature}`,
      });

      // 6. Calculate actual execution details
      const btcBought = Number(quote.outAmount) / 1e8;
      const avgPrice = totalUsdc / btcBought;

      // 7. Create position legs
      const createdLegs = createTwoLegPosition(
        { ...signal, price: avgPrice },
        this.config.tradeLegUsdc,
        this.config.atrTpMultiplier,
        this.config.atrTrailMultiplier,
        this.logger
      );
      const legs = createdLegs.map((leg) => ({ ...leg, btcMint }));

      this.logger?.info('✓ Position opened', {
        btcBought: btcBought.toFixed(8),
        avgPrice: avgPrice.toFixed(2),
        tpTarget: legs[0].targetPrice?.toFixed(2),
        trailingStop: legs[1].trailingStop?.toFixed(2),
      });

      return legs;
    } catch (error: any) {
      this.logger?.error('Failed to open position:', error.message);
      return null;
    }
  }

  /**
   * Close a position leg by selling BTC
   */
  async closeLeg(
    leg: PositionLeg,
    candle: Candle,
    reason: string
  ): Promise<SwapResult | void> {
    if (leg.status === 'CLOSED') {
      this.logger?.warn('Attempted to close already-closed leg:', leg.id);
      return;
    }

    try {
      this.logger?.info('🔄 Closing position leg...', {
        legId: leg.id,
        type: leg.type,
        reason,
        quantity: leg.quantity.toFixed(8),
      });

      // 1. Determine which BTC mint this leg uses
      const btcMint = leg.btcMint || this.config.cbBtcMint || this.config.wbtcMint;
      if (!btcMint) {
        this.logger?.error('No BTC mint configured for closing position');
        return;
      }

      // 2. Check if we can close
      const closeCheck = await canClosePosition(
        this.connection,
        this.wallet.publicKey,
        btcMint,
        leg.quantity,
        this.getBalanceConfig(),
        this.logger
      );

      if (!closeCheck.canClose) {
        this.logger?.error('Position close rejected:', closeCheck.reason);
        return;
      }

      this.logger?.info('✓ Balance check passed - can close position');

      // 3. Get quote for BTC → USDC
      const quote = await this.jupiterClient.getQuoteBtcToUsdc(leg.quantity, btcMint);

      if (!quote) {
        this.logger?.error('Failed to get quote from Jupiter');
        return;
      }

      const usdcReceived = Number(quote.outAmount) / 1e6;

      this.logger?.info('✓ Quote received', {
        inputBtc: leg.quantity.toFixed(8),
        outputUsdc: usdcReceived.toFixed(2),
        priceImpact: quote.priceImpactPct + '%',
      });

      // 4. Validate quote
      const isQuoteValid = await this.jupiterClient.validateQuote(quote, 2.0);

      if (!isQuoteValid) {
        this.logger?.error('Quote validation failed - price degraded too much');
        return;
      }

      this.logger?.info('✓ Quote validated');

      // 5. Build swap transaction
      const transaction = await this.jupiterClient.buildSwapTransaction(
        quote,
        this.wallet.publicKey
      );

      if (!transaction) {
        this.logger?.error('Failed to build swap transaction');
        return;
      }

      this.logger?.info('✓ Swap transaction built');

      // 6. Execute swap
      this.logger?.info('📤 Sending transaction to Solana...');

      const result = await sendAndConfirmVersionedTransaction(
        this.connection,
        transaction,
        this.wallet,
        {
          maxRetries: 3,
          skipPreflight: false,
        },
        this.logger
      );

      if (!result.success) {
        this.logger?.error('Swap transaction failed:', result.error);
        return;
      }

      this.logger?.info('✅ Position closed successfully!', {
        signature: result.signature,
        explorer: `https://solscan.io/tx/${result.signature}`,
      });

      // 7. Calculate P&L
      const avgExitPrice = usdcReceived / leg.quantity;
      const pnl = (avgExitPrice - leg.entryPrice) * leg.quantity;
      const pnlPct = ((avgExitPrice - leg.entryPrice) / leg.entryPrice) * 100;

      this.logger?.info('💰 Position P&L', {
        entry: leg.entryPrice.toFixed(2),
        exit: avgExitPrice.toFixed(2),
        pnl: pnl.toFixed(2),
        pnlPct: pnlPct.toFixed(2) + '%',
      });

      return {
        success: true,
        signature: result.signature,
        inputAmount: leg.quantity,
        outputAmount: usdcReceived,
        executionPrice: avgExitPrice,
      };
    } catch (error: any) {
      this.logger?.error('Failed to close position:', error.message);
      return;
    }
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
      this.config.atrTrailMultiplier,
      0.25, // breakEvenLockMultiplier
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
   * Get portfolio value (must fetch balances from chain)
   */
  async getPortfolioValue(currentPrice: number): Promise<number> {
    // This is a simplified implementation
    // In production, you'd want to fetch actual balances
    this.logger?.warn('getPortfolioValue not fully implemented for live broker');
    return 0;
  }

  /**
   * Get summary for logging
   */
  async getSummary(currentPrice: number): Promise<string> {
    return `
Live Broker Summary:
  Wallet: ${this.wallet.publicKey.toBase58()}
  RPC: ${this.config.rpcUrl}
  Trade Size: $${this.config.tradeLegUsdc} per leg
    `.trim();
  }

  /**
   * Get connection for external use
   */
  getConnection(): Connection {
    return this.connection;
  }
}
