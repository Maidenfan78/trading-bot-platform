import type { PositionLeg, AssetPositions, MultiAssetBotState, AssetConfig, AssetSignal, Logger } from '../types';
import { getOpenLegs } from '../strategy/position';

/**
 * Multi-Asset Manager
 *
 * Orchestrates trading across multiple assets.
 * Handles per-asset position tracking and risk management.
 */

export interface MultiAssetManagerConfig {
  assets: AssetConfig[];
  maxPositionsPerAsset: number;
  maxTotalPositions: number;
  minTimeBetweenTradesMs: number;
}

/**
 * Initialize multi-asset bot state
 */
export function initializeMultiAssetState(assets: AssetConfig[]): MultiAssetBotState {
  const enabledAssets = assets.filter(a => a.enabled);

  const assetPositions: AssetPositions[] = enabledAssets.map(asset => ({
    asset: asset.symbol,
    openLegs: [],
    lastSignalTime: 0,
    lastTradeTime: 0,
  }));

  return {
    lastProcessedCandleTime: 0,
    lastDayReset: new Date().toISOString().split('T')[0],
    assetPositions,
  };
}

/**
 * Get positions for a specific asset
 */
export function getAssetPositions(
  state: MultiAssetBotState,
  assetSymbol: string
): AssetPositions | undefined {
  return state.assetPositions.find(ap => ap.asset === assetSymbol);
}

/**
 * Update positions for a specific asset
 */
export function updateAssetPositions(
  state: MultiAssetBotState,
  assetSymbol: string,
  updatedLegs: PositionLeg[]
): void {
  const assetPos = getAssetPositions(state, assetSymbol);
  if (assetPos) {
    assetPos.openLegs = updatedLegs;
  }
}

/**
 * Get total number of open positions across all assets
 */
export function getTotalOpenPositions(state: MultiAssetBotState): number {
  return state.assetPositions.reduce((total, ap) => {
    return total + getOpenPositionCountForAsset(ap);
  }, 0);
}

/**
 * Get total number of open assets (assets with at least one open position)
 */
export function getTotalOpenAssets(state: MultiAssetBotState): number {
  return state.assetPositions.filter(ap => getOpenPositionCountForAsset(ap) > 0).length;
}

/**
 * Get number of open positions for a specific asset
 */
function getOpenPositionCountForAsset(assetPositions: AssetPositions): number {
  const openLegs = getOpenLegs(assetPositions.openLegs);
  const uniquePositions = new Set<string>();

  for (const leg of openLegs) {
    const positionKey = leg.positionId ?? `${assetPositions.asset}:${leg.entryTime}`;
    uniquePositions.add(positionKey);
  }

  return uniquePositions.size;
}

/**
 * Check if an asset can trade based on cooldown and position limits
 */
export function canAssetTrade(
  state: MultiAssetBotState,
  assetSymbol: string,
  config: MultiAssetManagerConfig,
  currentTime: number
): { canTrade: boolean; reason?: string } {
  const assetPos = getAssetPositions(state, assetSymbol);
  if (!assetPos) {
    return { canTrade: false, reason: 'Asset not found in state' };
  }

  // Check per-asset position limit
  const assetOpenPositions = getOpenPositionCountForAsset(assetPos);
  if (assetOpenPositions >= config.maxPositionsPerAsset) {
    return {
      canTrade: false,
      reason: `${assetSymbol} at max positions (${assetOpenPositions}/${config.maxPositionsPerAsset})`,
    };
  }

  // Check total position limit across all assets
  const totalOpen = getTotalOpenPositions(state);
  if (totalOpen >= config.maxTotalPositions) {
    return {
      canTrade: false,
      reason: `Total positions at max (${totalOpen}/${config.maxTotalPositions})`,
    };
  }

  // Check cooldown period
  if (assetPos.lastTradeTime > 0) {
    const timeSinceLastTrade = currentTime - assetPos.lastTradeTime;
    if (timeSinceLastTrade < config.minTimeBetweenTradesMs) {
      const hoursRemaining = (config.minTimeBetweenTradesMs - timeSinceLastTrade) / (60 * 60 * 1000);
      return {
        canTrade: false,
        reason: `${assetSymbol} in cooldown (${hoursRemaining.toFixed(1)}h remaining)`,
      };
    }
  }

  return { canTrade: true };
}

/**
 * Record that a trade was executed for an asset
 */
export function recordAssetTrade(
  state: MultiAssetBotState,
  assetSymbol: string,
  timestamp: number
): void {
  const assetPos = getAssetPositions(state, assetSymbol);
  if (assetPos) {
    assetPos.lastTradeTime = timestamp;
    assetPos.lastSignalTime = timestamp;
  }
}

/**
 * Get summary of all asset positions
 */
export function getMultiAssetSummary(state: MultiAssetBotState): string {
  const lines: string[] = [];
  lines.push('\n=== Multi-Asset Position Summary ===');

  for (const assetPos of state.assetPositions) {
    const openLegs = getOpenLegs(assetPos.openLegs);
    const openPositions = getOpenPositionCountForAsset(assetPos);
    const tpLegs = openLegs.filter(l => l.type === 'TP');
    const runnerLegs = openLegs.filter(l => l.type === 'RUNNER');

    lines.push(`\n${assetPos.asset}:`);
    lines.push(`  Open Positions: ${openPositions} (${tpLegs.length} TP, ${runnerLegs.length} Runner)`);

    if (openLegs.length > 0) {
      for (const leg of openLegs) {
        const age = leg.entryTime ? `${((Date.now() - leg.entryTime) / (60 * 60 * 1000)).toFixed(1)}h` : 'N/A';
        lines.push(`    ${leg.type}: Entry ${leg.entryPrice.toFixed(2)}, Age ${age}`);
      }
    }

    if (assetPos.lastTradeTime > 0) {
      const lastTrade = new Date(assetPos.lastTradeTime).toISOString();
      lines.push(`  Last Trade: ${lastTrade}`);
    }
  }

  const totalOpen = getTotalOpenPositions(state);
  const totalAssets = getTotalOpenAssets(state);
  lines.push(`\nTotal: ${totalOpen} positions across ${totalAssets} assets`);
  lines.push('===================================\n');

  return lines.join('\n');
}

/**
 * Filter signals based on risk management rules
 *
 * Returns which signals can actually be traded
 */
export function filterTradableSignals(
  state: MultiAssetBotState,
  signals: AssetSignal[],
  config: MultiAssetManagerConfig,
  logger?: Logger
): AssetSignal[] {
  const tradableSignals: AssetSignal[] = [];

  for (const signal of signals) {
    if (signal.type !== 'LONG') continue; // Only process LONG signals

    const canTrade = canAssetTrade(
      state,
      signal.asset,
      config,
      signal.timestamp
    );

    if (canTrade.canTrade) {
      tradableSignals.push(signal);
    } else {
      logger?.info(`Signal filtered: ${signal.asset} - ${canTrade.reason}`);
    }
  }

  return tradableSignals;
}

/**
 * Get enabled assets from config
 */
export function getEnabledAssets(assets: AssetConfig[]): AssetConfig[] {
  return assets.filter(a => a.enabled);
}

/**
 * Get asset by symbol
 */
export function getAsset(assets: AssetConfig[], symbol: string): AssetConfig | undefined {
  return assets.find(a => a.symbol === symbol);
}

/**
 * Get total capital required per signal (sum of all enabled assets)
 */
export function getTotalCapitalPerSignal(assets: AssetConfig[]): number {
  return getEnabledAssets(assets).reduce((sum, asset) => sum + (asset.tradeLegUsdc * 2), 0);
}
