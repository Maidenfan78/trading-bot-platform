import type { QuoteGetRequest } from '@jup-ag/api';
import { createJupiterApiClient } from '@jup-ag/api';
import type { PublicKey} from '@solana/web3.js';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import type { QuoteResponse, Logger } from '../types';

/**
 * Jupiter DEX Integration
 *
 * Handles quote fetching and swap transaction building via Jupiter aggregator.
 * Jupiter finds the best route across all Solana DEXs.
 *
 * API Documentation: https://station.jup.ag/api-v6
 */

export interface JupiterConfig {
  rpcUrl: string;
  usdcMint: string;
  cbBtcMint?: string;
  wbtcMint: string;
  slippageBps: number;
  maxPriceImpactBps: number;
}

export class JupiterClient {
  private jupiterApi: ReturnType<typeof createJupiterApiClient>;
  private connection: Connection;
  private config: JupiterConfig;
  private logger?: Logger;

  constructor(config: JupiterConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.jupiterApi = createJupiterApiClient();

    this.logger?.info('Jupiter client initialized', {
      rpc: config.rpcUrl,
      slippageBps: config.slippageBps,
    });
  }

  /**
   * Get quote for USDC → BTC swap
   * Tries cbBTC first, falls back to WBTC if quote fails or price impact too high
   */
  async getQuoteUsdcToBtc(
    usdcAmount: number
  ): Promise<{ quote: QuoteResponse; btcMint: string } | null> {
    this.logger?.info(`Requesting quote: ${usdcAmount} USDC → BTC`);

    // Convert USDC amount to lamports (6 decimals)
    const usdcLamports = Math.floor(usdcAmount * 1_000_000);

    if (this.config.cbBtcMint) {
      // Try cbBTC first (preferred)
      try {
        this.logger?.info('Attempting cbBTC quote...');
        const cbBtcQuote = await this.getQuote(
          this.config.usdcMint,
          this.config.cbBtcMint,
          usdcLamports
        );

        if (cbBtcQuote && this.isQuoteAcceptable(cbBtcQuote)) {
          this.logger?.info('V cbBTC quote accepted', {
            priceImpact: cbBtcQuote.priceImpactPct.toFixed(4) + '%',
            outAmount: cbBtcQuote.outAmount,
          });
          return { quote: cbBtcQuote, btcMint: this.config.cbBtcMint };
        } else {
          this.logger?.warn('cbBTC quote rejected (price impact too high or failed)');
        }
      } catch (error: any) {
        this.logger?.warn('cbBTC quote failed:', error.message);
      }
    }

    // Fall back to WBTC
    try {
      this.logger?.info('Attempting WBTC quote (fallback)...');
      const wbtcQuote = await this.getQuote(
        this.config.usdcMint,
        this.config.wbtcMint,
        usdcLamports
      );

      if (wbtcQuote && this.isQuoteAcceptable(wbtcQuote)) {
        this.logger?.info('✓ WBTC quote accepted', {
          priceImpact: wbtcQuote.priceImpactPct.toFixed(4) + '%',
          outAmount: wbtcQuote.outAmount,
        });
        return { quote: wbtcQuote, btcMint: this.config.wbtcMint };
      } else {
        this.logger?.error('WBTC quote also rejected');
      }
    } catch (error: any) {
      this.logger?.error('WBTC quote failed:', error.message);
    }

    this.logger?.error('All quote attempts failed');
    return null;
  }

  /**
   * Get quote for BTC → USDC swap
   * Automatically determines if input is cbBTC or WBTC
   */
  async getQuoteBtcToUsdc(
    btcAmount: number,
    btcMint: string
  ): Promise<QuoteResponse | null> {
    this.logger?.info(`Requesting quote: ${btcAmount} BTC → USDC`);

    // BTC has 8 decimals
    const btcLamports = Math.floor(btcAmount * 100_000_000);

    try {
      const quote = await this.getQuote(btcMint, this.config.usdcMint, btcLamports);

      if (quote && this.isQuoteAcceptable(quote)) {
        this.logger?.info('✓ BTC → USDC quote accepted', {
          priceImpact: quote.priceImpactPct.toFixed(4) + '%',
          outAmount: quote.outAmount,
        });
        return quote;
      } else {
        this.logger?.warn('BTC → USDC quote rejected (price impact too high)');
      }
    } catch (error: any) {
      this.logger?.error('BTC → USDC quote failed:', error.message);
    }

    return null;
  }

  /**
   * Internal method to fetch quote from Jupiter
   */
  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<QuoteResponse | null> {
    try {
      const params: QuoteGetRequest = {
        inputMint,
        outputMint,
        amount,
        slippageBps: this.config.slippageBps,
        onlyDirectRoutes: false, // Allow multi-hop for best price
        asLegacyTransaction: false, // Use versioned transactions
      };

      const jupQuote = await this.jupiterApi.quoteGet(params);

      if (!jupQuote) {
        return null;
      }

      // Convert to our QuoteResponse format
      const quote: QuoteResponse = {
        inputMint,
        outputMint,
        inAmount: jupQuote.inAmount,
        outAmount: jupQuote.outAmount,
        priceImpactPct: jupQuote.priceImpactPct ? parseFloat(jupQuote.priceImpactPct) : 0,
        route: jupQuote,
      };

      return quote;
    } catch (error: any) {
      this.logger?.error('Jupiter quote API error:', {
        error: error.message,
        inputMint,
        outputMint,
        amount,
      });
      return null;
    }
  }

  /**
   * Check if quote is acceptable based on price impact
   */
  private isQuoteAcceptable(quote: QuoteResponse): boolean {
    const maxImpactBps = this.config.maxPriceImpactBps;
    const impactBps = quote.priceImpactPct * 100; // Convert to BPS

    if (impactBps > maxImpactBps) {
      this.logger?.warn(`Quote rejected: price impact ${impactBps.toFixed(2)} BPS > max ${maxImpactBps} BPS`);
      return false;
    }

    return true;
  }

  /**
   * Build swap transaction from quote
   * Returns a versioned transaction ready to be signed and sent
   */
  async buildSwapTransaction(
    quote: QuoteResponse,
    userPublicKey: PublicKey,
    wrapUnwrapSOL: boolean = true
  ): Promise<VersionedTransaction | null> {
    try {
      this.logger?.info('Building swap transaction...', {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
      });

      const swapRequest = {
        quoteResponse: quote.route as any,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: wrapUnwrapSOL,
        dynamicComputeUnitLimit: true, // Optimize compute units
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: 'high' as const,
            maxLamports: 1000000, // 0.001 SOL max priority fee
            global: false,
          },
        },
      };

      const swapResult = await this.jupiterApi.swapPost({ swapRequest } as any);

      if (!swapResult || !swapResult.swapTransaction) {
        this.logger?.error('Failed to build swap transaction: no transaction returned');
        return null;
      }

      // Deserialize the transaction
      const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      this.logger?.info('✓ Swap transaction built successfully');
      return transaction;
    } catch (error: any) {
      this.logger?.error('Failed to build swap transaction:', error.message);
      return null;
    }
  }

  /**
   * Validate that quote hasn't degraded significantly before executing
   * Returns true if current quote is still acceptable
   */
  async validateQuote(
    originalQuote: QuoteResponse,
    maxDegradationPct: number = 1.0
  ): Promise<boolean> {
    try {
      // Get fresh quote with same parameters
      const freshQuote = await this.getQuote(
        originalQuote.inputMint,
        originalQuote.outputMint,
        parseInt(originalQuote.inAmount)
      );

      if (!freshQuote) {
        this.logger?.warn('Quote validation failed: could not fetch fresh quote');
        return false;
      }

      // Calculate degradation
      const originalOut = parseInt(originalQuote.outAmount);
      const freshOut = parseInt(freshQuote.outAmount);
      const degradationPct = ((originalOut - freshOut) / originalOut) * 100;

      if (degradationPct > maxDegradationPct) {
        this.logger?.warn(`Quote degraded by ${degradationPct.toFixed(2)}% (max: ${maxDegradationPct}%)`);
        return false;
      }

      this.logger?.info(`✓ Quote validation passed (degradation: ${degradationPct.toFixed(2)}%)`);
      return true;
    } catch (error: any) {
      this.logger?.error('Quote validation error:', error.message);
      return false;
    }
  }

  /**
   * Get connection instance for transaction sending
   */
  getConnection(): Connection {
    return this.connection;
  }
}

/**
 * Helper to calculate execution price from quote
 */
export function getExecutionPrice(quote: QuoteResponse, inputDecimals: number, outputDecimals: number): number {
  const inAmount = parseInt(quote.inAmount) / Math.pow(10, inputDecimals);
  const outAmount = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);

  return inAmount / outAmount; // Price in terms of input per output
}
