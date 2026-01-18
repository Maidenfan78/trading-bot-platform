/**
 * Price Provider Service
 *
 * Pluggable price provider for fetching live market data.
 * Default implementation uses Hyperliquid API.
 */

interface PriceCache {
  prices: Record<string, number>;
  timestamp: number;
}

const CACHE_DURATION_MS = 5000; // 5 seconds
const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

// Asset name mapping: bot state name -> API name
const DEFAULT_ASSET_MAP: Record<string, string> = {
  wETH: 'ETH',
  wBTC: 'BTC',
  cbBTC: 'BTC',
};

/**
 * Price Provider Interface
 */
export interface PriceProvider {
  getCurrentPrices(): Promise<Record<string, number>>;
  getAssetPrice(symbol: string): Promise<number | undefined>;
  normalizeAssetName(symbol: string): string;
}

/**
 * Hyperliquid Price Provider
 */
export class HyperliquidPriceProvider implements PriceProvider {
  private priceCache: PriceCache | null = null;
  private assetMap: Record<string, string>;

  constructor(assetMap?: Record<string, string>) {
    this.assetMap = { ...DEFAULT_ASSET_MAP, ...assetMap };
  }

  /**
   * Fetch current mid prices for all assets from Hyperliquid
   * Uses 5-second cache to avoid excessive API calls
   */
  async getCurrentPrices(): Promise<Record<string, number>> {
    // Return cached prices if still valid
    if (this.priceCache && Date.now() - this.priceCache.timestamp < CACHE_DURATION_MS) {
      return this.priceCache.prices;
    }

    try {
      const response = await fetch(HYPERLIQUID_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'allMids',
        }),
      });

      if (!response.ok) {
        throw new Error(`Hyperliquid API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Convert array of prices to object keyed by asset name
      const prices: Record<string, number> = {};

      if (typeof data === 'object' && data !== null) {
        for (const [asset, priceStr] of Object.entries(data)) {
          const price = parseFloat(priceStr as string);
          if (!isNaN(price)) {
            prices[asset] = price;
          }
        }
      }

      // Update cache
      this.priceCache = {
        prices,
        timestamp: Date.now(),
      };

      return prices;
    } catch (error) {
      console.error('Failed to fetch prices from Hyperliquid:', error);

      // Return stale cache if available, otherwise empty object
      if (this.priceCache) {
        console.warn('Using stale price cache due to API error');
        return this.priceCache.prices;
      }

      return {};
    }
  }

  /**
   * Normalize asset name from bot state to API format
   */
  normalizeAssetName(symbol: string): string {
    return this.assetMap[symbol] || symbol;
  }

  /**
   * Get price for a specific asset
   */
  async getAssetPrice(symbol: string): Promise<number | undefined> {
    const prices = await this.getCurrentPrices();
    const normalizedSymbol = this.normalizeAssetName(symbol);
    return prices[normalizedSymbol];
  }

  /**
   * Clear the price cache
   */
  clearCache(): void {
    this.priceCache = null;
  }
}

/**
 * Static price provider for testing or paper mode
 */
export class StaticPriceProvider implements PriceProvider {
  constructor(private prices: Record<string, number>) {}

  async getCurrentPrices(): Promise<Record<string, number>> {
    return this.prices;
  }

  normalizeAssetName(symbol: string): string {
    return symbol;
  }

  async getAssetPrice(symbol: string): Promise<number | undefined> {
    return this.prices[symbol];
  }

  setPrice(symbol: string, price: number): void {
    this.prices[symbol] = price;
  }
}

// Default instance
let defaultProvider: PriceProvider = new HyperliquidPriceProvider();

/**
 * Get the default price provider
 */
export function getDefaultPriceProvider(): PriceProvider {
  return defaultProvider;
}

/**
 * Set the default price provider
 */
export function setDefaultPriceProvider(provider: PriceProvider): void {
  defaultProvider = provider;
}

// Convenience functions using default provider
export async function getCurrentPrices(): Promise<Record<string, number>> {
  return defaultProvider.getCurrentPrices();
}

export function normalizeAssetName(symbol: string): string {
  return defaultProvider.normalizeAssetName(symbol);
}

export async function getAssetPrice(symbol: string): Promise<number | undefined> {
  return defaultProvider.getAssetPrice(symbol);
}
