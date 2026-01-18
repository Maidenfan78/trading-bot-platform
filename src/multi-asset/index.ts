/**
 * Multi-Asset Module
 *
 * Exports multi-asset trading utilities.
 */

export {
  initializeMultiAssetState,
  getAssetPositions,
  updateAssetPositions,
  getTotalOpenPositions,
  getTotalOpenAssets,
  canAssetTrade,
  recordAssetTrade,
  getMultiAssetSummary,
  filterTradableSignals,
  getEnabledAssets,
  getAsset,
  getTotalCapitalPerSignal,
  type MultiAssetManagerConfig,
} from './MultiAssetManager';
