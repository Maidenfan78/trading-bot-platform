import type { Keypair, VersionedTransaction } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Signal, PositionLeg, Candle, CloseLegResult, CloseLegOptions, Logger } from '../types';
import type { Broker, LiveBrokerConfig, TradeAsset } from '../core/Broker';
import { JupiterClient } from '../solana/jupiter';
import { loadWallet, sendAndConfirmVersionedTransaction } from '../solana/wallet';
import type { BalanceConfig } from '../solana/balances';
import { canTrade, canTradeAsset, canClosePosition, getTokenBalance } from '../solana/balances';
import { reconcileFilledQuantity } from './fillReconciliation';
import { confirmedSaleProceeds } from './saleProceeds';
import { executeCloseIntent } from './closeIntent';
import { UnresolvedExecutionError, isUnresolvedExecutionError } from './unresolvedExecution';
import type { UnresolvedExecutionEvidence } from './unresolvedExecution';
import { createTwoLegPosition, updatePositions, closeRunnersOnTrimSignal } from '../strategy/position';

/** Solana's transaction id is its first signature, so it is known once signed even if no send reply arrived. */
function signedSignature(transaction: VersionedTransaction): string | undefined {
  const first = (transaction as { signatures?: Uint8Array[] }).signatures?.[0];
  return first && first.some((byte) => byte !== 0) ? bs58.encode(first) : undefined;
}

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
      minAssetBalance: this.config.minAssetBalance,
      minUsdcReserve: this.config.minUsdcReserve,
    };
  }

  /**
   * Open a two-leg position with real BTC purchase.
   *
   * Returns null only when nothing can have executed. Once a transaction may have
   * been submitted, an outcome that cannot be established throws
   * `UnresolvedExecutionError` with its evidence instead (BUG-047): the caller must
   * keep its spend claim rather than refund it.
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

    // Set once a transaction may reach the chain; from then on failure is not proof of no spend.
    let pending: UnresolvedExecutionEvidence | undefined;
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

      pending = {
        recentBlockhash: (transaction as { message?: { recentBlockhash?: string } }).message?.recentBlockhash,
        mint: filledMint,
        usdcCommitted: totalUsdc,
      };
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
      pending.signature = result.signature || signedSignature(transaction);

      if (!result.success) {
        // A returned signature without `unresolved` means the chain answered: the
        // transaction landed and failed, so nothing moved. Anything else - fate
        // unknown, or no send reply at all - may still land (BUG-030/047).
        if (result.unresolved || !result.signature) {
          this.logger?.error(
            'RECONCILE REQUIRED - swap was sent but never resolved. The wallet may hold ' +
              'coins with no position recorded against them: no take-profit will fire and ' +
              'the accumulation ledger has no cost basis for them. Check the signature ' +
              'before letting this asset trade again.',
            {
              signature: pending.signature,
              explorer: pending.signature ? `https://solscan.io/tx/${pending.signature}` : undefined,
              mint: filledMint,
              usdcCommitted: totalUsdc,
            }
          );
          throw new UnresolvedExecutionError(result.error || 'Buy transaction outcome unknown', pending);
        }
        this.logger?.error('Swap transaction failed:', {
          error: result.error,
          signature: result.signature,
        });
        return null;
      }
      pending.landed = true;

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
        throw new UnresolvedExecutionError('Buy landed but its fill quantity is unknown', pending);
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
        entrySignature: result.signature,
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
      if (isUnresolvedExecutionError(error)) throw error;
      this.logger?.error('Failed to open position:', error.message);
      if (pending) {
        throw new UnresolvedExecutionError(error.message || 'Buy execution failed after submission', pending);
      }
      return null;
    }
  }

  /**
   * Close a position leg by selling BTC
   */
  async closeLeg(
    leg: PositionLeg,
    candle: Candle,
    reason: string,
    options: CloseLegOptions = {}
  ): Promise<CloseLegResult> {
    if (leg.status !== 'OPEN' || leg.closePending) {
      this.logger?.warn('Attempted to close already-closed leg:', leg.id);
      return { success: false, error: 'Leg is not open or requires reconciliation' };
    }

    let submissionStarted = false;
    let signature: string | undefined;
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
        return { success: false, error: 'No mint recorded on leg' };
      }
      const decimals = leg.decimals ?? 8;

      // 2. Check if we can close
      const closeCheck = await canClosePosition(
        this.connection,
        this.wallet.publicKey,
        mint,
        leg.quantity,
        this.getBalanceConfig(),
        this.logger,
        leg.asset
      );

      if (!closeCheck.canClose) {
        this.logger?.error('Position close rejected:', closeCheck.reason);
        return { success: false, error: closeCheck.reason || 'Sale balance check rejected' };
      }

      this.logger?.info('✓ Balance check passed - can close position');

      // 3. Get quote for asset → USDC, scaled by this leg's real decimals
      const quote = await this.jupiterClient.getQuoteTokenToUsdc(leg.quantity, mint, decimals);

      if (!quote) {
        this.logger?.error('Failed to get quote from Jupiter');
        return { success: false, error: 'No sale quote available' };
      }

      const usdcReceived = Number(quote.outAmount) / 1e6;
      if (options.minOutputUsdc !== undefined) {
        const minimumRaw = Math.ceil(options.minOutputUsdc * 1_000_000);
        if (!Number.isSafeInteger(minimumRaw) || minimumRaw <= 0 ||
            BigInt(quote.outAmount) < BigInt(minimumRaw)) {
          return { success: false, error: 'Sale quote is below the required minimum proceeds' };
        }
        // Jupiter encodes this threshold into the transaction, so adverse movement
        // must fail the swap instead of selling below the consumer's target.
        const route = quote.route as { otherAmountThreshold?: string; swapMode?: string };
        if (!route || route.swapMode !== 'ExactIn' || !/^\d+$/.test(route.otherAmountThreshold ?? '')) {
          return { success: false, error: 'Cannot enforce minimum proceeds on this sale quote' };
        }
        if (BigInt(route.otherAmountThreshold!) < BigInt(minimumRaw)) {
          quote.route = { ...route, otherAmountThreshold: String(minimumRaw) };
        }
      }

      this.logger?.info('✓ Quote received', {
        inputBtc: leg.quantity.toFixed(8),
        outputUsdc: usdcReceived.toFixed(2),
        priceImpact: quote.priceImpactPct + '%',
      });

      // 4. Validate quote
      const isQuoteValid = await this.jupiterClient.validateQuote(quote, 2.0);

      if (!isQuoteValid) {
        this.logger?.error('Quote validation failed - price degraded too much');
        return { success: false, error: 'Sale quote validation failed' };
      }

      this.logger?.info('✓ Quote validated');

      // 5. Build swap transaction
      const transaction = await this.jupiterClient.buildSwapTransaction(
        quote,
        this.wallet.publicKey
      );

      if (!transaction) {
        this.logger?.error('Failed to build swap transaction');
        return { success: false, error: 'Could not build sale transaction' };
      }

      this.logger?.info('✓ Swap transaction built');

      // 6. Execute swap
      this.logger?.info('📤 Sending transaction to Solana...');

      submissionStarted = true;
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
      signature = result.signature || undefined;

      if (!result.success) {
        this.logger?.error('Swap transaction failed:', result.error);
        return {
          success: false,
          error: result.error || 'Sale transaction failed',
          signature,
          // With no returned signature, a lost send response cannot prove that
          // nothing landed. Quarantine rather than inviting another sale.
          unresolved: result.unresolved || !signature || undefined,
        };
      }

      const proceeds = await confirmedSaleProceeds(
        this.connection, result.signature, this.wallet.publicKey, this.config.usdcMint
      );
      if (!proceeds || (options.minOutputUsdc !== undefined && proceeds.usdc < options.minOutputUsdc)) {
        return {
          success: false,
          unresolved: true,
          signature,
          error: 'Sale confirmed but actual USDC proceeds require reconciliation',
        };
      }

      this.logger?.info('✅ Position closed successfully!', {
        signature: result.signature,
        explorer: `https://solscan.io/tx/${result.signature}`,
      });

      // 7. Calculate P&L
      const avgExitPrice = proceeds.usdc / leg.quantity;
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
        outputAmount: proceeds.usdc,
        executionPrice: avgExitPrice,
        executedAt: proceeds.executedAt,
      };
    } catch (error: any) {
      this.logger?.error('Failed to close position:', error.message);
      return {
        success: false,
        error: error.message || 'Sale execution failed',
        signature,
        unresolved: submissionStarted || undefined,
      };
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
        updatedLegs[i] = await executeCloseIntent(this, legs[i], leg, candle, leg.closeReason || 'Unknown');
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
        trimmedLegs[i] = await executeCloseIntent(this, legs[i], leg, candle, 'Trim signal (MFI < 70)');
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
