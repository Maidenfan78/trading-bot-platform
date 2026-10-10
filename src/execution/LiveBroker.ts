import type { Keypair } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Signal, PositionLeg, Candle, SwapResult, Logger } from '../types';
import type { Broker, LiveBrokerConfig, TradeAsset } from '../core/Broker';
import { JupiterClient } from '../solana/jupiter';
import { loadWallet, sendAndConfirmVersionedTransaction } from '../solana/wallet';
import type { BalanceConfig } from '../solana/balances';
import { canTrade, canTradeAsset, canClosePosition, getTokenBalance } from '../solana/balances';
import { reconcileFilledQuantity } from './fillReconciliation';
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
  async openPosition(
    signal: Signal,
    candle: Candle,
    asset?: TradeAsset
  ): Promise<PositionLeg[] | null> {
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

      // 1. Check if we can trade. When the caller names an asset we check that
      //    asset's own mint; the legacy path only ever knew about cbBTC/WBTC.
      if (asset) {
        const assetCheck = await canTradeAsset(
          this.connection,
          this.wallet.publicKey,
          this.config.usdcMint,
          asset.mint,
          this.config.tradeLegUsdc,
          this.getBalanceConfig(),
          this.logger
        );

        if (!assetCheck.canTrade) {
          this.logger?.error('Trade rejected - insufficient balance:', assetCheck.reason);
          return null;
        }

        this.logger?.info('Balance check passed', {
          asset: asset.symbol ?? asset.mint,
          usdcBalance: assetCheck.usdc.toFixed(2),
          assetBalance: assetCheck.asset,
        });
      } else {
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

        this.logger?.info('Balance check passed', {
          usdcBalance: tradeCheck.usdc.toFixed(2),
          btcBalance: tradeCheck.btc.toFixed(8),
        });
      }

      // 2. Get quote from Jupiter. With a named asset we quote that exact mint;
      //    without one we keep the legacy cbBTC-then-WBTC behaviour for the BTC bot.
      const totalUsdc = this.config.tradeLegUsdc * 2; // Two legs
      const quoteResult = asset
        ? await this.jupiterClient.getQuoteUsdcToToken(totalUsdc, asset.mint, asset.decimals)
        : await this.jupiterClient.getQuoteUsdcToBtc(totalUsdc);

      if (!quoteResult) {
        this.logger?.error('Failed to get quote from Jupiter');
        return null;
      }

      const quote = quoteResult.quote;
      const filledMint = asset ? asset.mint : (quoteResult as { btcMint: string }).btcMint;
      const filledDecimals = asset ? asset.decimals : 8;

      this.logger?.info('Quote received', {
        inputUsdc: totalUsdc,
        outputQty: Number(quote.outAmount) / Math.pow(10, filledDecimals),
        mint: filledMint,
        decimals: filledDecimals,
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

      // 5. Execute swap.
      //
      // Read the destination balance FIRST. The fill has to be measured, not
      // taken from the quote (BUG-031), and it has to be measured with the same
      // instrument that will later check it at sell time - canClosePosition
      // also uses getTokenBalance - so the recorded quantity and that check
      // agree by construction instead of by luck.
      let balanceBefore: number | null = null;
      try {
        balanceBefore = await getTokenBalance(
          this.connection,
          this.wallet.publicKey,
          new PublicKey(filledMint),
          this.logger
        );
      } catch (error: any) {
        this.logger?.warn(
          'Could not read the pre-swap balance; the fill will have to fall back to the quote.',
          { mint: filledMint, error: error.message }
        );
      }

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
        if (result.unresolved) {
          // Sent, fate unknown. This is NOT "it did not happen": the wallet may
          // hold coins this process never recorded, with no leg, no TP, and no
          // ledger entry (BUG-030). Returning null is still the only honest
          // option - we cannot invent a quantity - but it must be impossible to
          // miss in the logs, and the signature must survive so it can be
          // looked up.
          this.logger?.error(
            'RECONCILE REQUIRED - swap was sent but never resolved. The wallet may hold ' +
              'coins with no position recorded against them: no take-profit will fire and ' +
              'the accumulation ledger has no cost basis for them. Check the signature ' +
              'before letting this asset trade again.',
            {
              signature: result.signature,
              explorer: `https://solscan.io/tx/${result.signature}`,
              mint: filledMint,
              usdcCommitted: totalUsdc,
            }
          );
        } else {
          this.logger?.error('Swap transaction failed:', {
            error: result.error,
            signature: result.signature || '(never sent)',
          });
        }
        return null;
      }

      this.logger?.info('✅ Swap executed successfully!', {
        signature: result.signature,
        explorer: `https://solscan.io/tx/${result.signature}`,
      });

      // 6. Work out what actually filled. Scale by the mint's real decimals
      //    rather than a hardcoded 1e8 - SOL is 9 and JUP is 6, and avgPrice feeds
      //    the TP target, so getting this wrong corrupts the position (BUG-026).
      const quotedQty = Number(quote.outAmount) / Math.pow(10, filledDecimals);

      let measuredDelta: number | null = null;
      if (balanceBefore !== null) {
        try {
          const balanceAfter = await getTokenBalance(
            this.connection,
            this.wallet.publicKey,
            new PublicKey(filledMint),
            this.logger
          );
          measuredDelta = balanceAfter - balanceBefore;
        } catch (error: any) {
          this.logger?.warn('Could not read the post-swap balance.', {
            mint: filledMint,
            error: error.message,
          });
        }
      }

      const fill = reconcileFilledQuantity(quotedQty, measuredDelta);
      if (fill.warning) {
        // Loud on purpose: the leg is about to carry an estimated quantity, so
        // holdings and cost basis are approximate until reconciled.
        this.logger?.error(`Fill quantity is an ESTIMATE: ${fill.warning}`, {
          signature: result.signature,
          mint: filledMint,
          quotedQty,
          measuredDelta,
        });
      }

      const qtyBought = fill.quantity;
      if (!(qtyBought > 0)) {
        this.logger?.error(
          'RECONCILE REQUIRED - swap confirmed but no usable fill quantity could be ' +
            'determined, so no position can be recorded against coins the wallet now holds.',
          { signature: result.signature, mint: filledMint, quotedQty, measuredDelta }
        );
        return null;
      }

      const avgPrice = totalUsdc / qtyBought;

      this.logger?.info('Fill measured', {
        source: fill.source,
        qtyBought,
        quotedQty,
        slippagePct: (((quotedQty - qtyBought) / quotedQty) * 100).toFixed(3),
      });

      // 7. Create position legs
      const createdLegs = createTwoLegPosition(
        { ...signal, price: avgPrice },
        this.config.tradeLegUsdc,
        this.config.atrTpMultiplier,
        this.config.atrTrailMultiplier,
        this.logger
      );
      const legs = createdLegs.map((leg) => ({
        ...leg,
        mint: filledMint,
        decimals: filledDecimals,
        btcMint: filledMint, // legacy field, kept so old readers still resolve a mint
      }));

      this.logger?.info('Position opened', {
        qtyBought,
        mint: filledMint,
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

      // 1. Which mint does this leg actually hold? Never fall back to a configured
      //    BTC mint: a leg whose mint is unknown is a leg we have no business
      //    selling, and guessing disposes of the wrong asset for real (BUG-027).
      const mint = leg.mint || leg.btcMint;
      if (!mint) {
        this.logger?.error(
          'Refusing to close leg: no mint recorded on it. Selling a guessed mint would ' +
          'dispose of the wrong asset.',
          { legId: leg.id, asset: leg.asset }
        );
        return;
      }
      const decimals = leg.decimals ?? 8;

      // 2. Check if we can close
      const closeCheck = await canClosePosition(
        this.connection,
        this.wallet.publicKey,
        mint,
        leg.quantity,
        this.getBalanceConfig(),
        this.logger
      );

      if (!closeCheck.canClose) {
        this.logger?.error('Position close rejected:', closeCheck.reason);
        return;
      }

      this.logger?.info('✓ Balance check passed - can close position');

      // 3. Get quote for asset → USDC, scaled by this leg's real decimals
      const quote = await this.jupiterClient.getQuoteTokenToUsdc(leg.quantity, mint, decimals);

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
