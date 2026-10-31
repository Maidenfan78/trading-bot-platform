import {
  canAssetTrade,
  initializeMultiAssetState,
  updateAssetPositions,
  getTotalOpenPositions,
} from '../src/multi-asset/MultiAssetManager';
import type { PositionLeg } from '../src/types';

describe('MultiAssetManager position counts', () => {
  const assets = [
    { symbol: 'BTC', name: 'Bitcoin', binanceSymbol: 'BTCUSDT', tradeLegUsdc: 100, enabled: true },
    { symbol: 'ETH', name: 'Ethereum', binanceSymbol: 'ETHUSDT', tradeLegUsdc: 100, enabled: true },
  ];

  it('counts open positions by positionId instead of legs', () => {
    const state = initializeMultiAssetState(assets);
    const legs: PositionLeg[] = [
      {
        id: 'tp1',
        positionId: 'pos-1',
        type: 'TP',
        entryPrice: 100,
        quantity: 1,
        entryTime: 1,
        targetPrice: 110,
        status: 'OPEN',
      },
      {
        id: 'runner1',
        positionId: 'pos-1',
        type: 'RUNNER',
        entryPrice: 100,
        quantity: 1,
        entryTime: 1,
        status: 'OPEN',
      },
    ];

    updateAssetPositions(state, 'BTC', legs);

    const result = canAssetTrade(state, 'BTC', {
      assets,
      maxPositionsPerAsset: 2,
      maxTotalPositions: 3,
      minTimeBetweenTradesMs: 0,
    }, 2);

    expect(result.canTrade).toBe(true);
    expect(getTotalOpenPositions(state)).toBe(1);
  });

  it('falls back to entryTime grouping when positionId is missing', () => {
    const state = initializeMultiAssetState(assets);
    const legs: PositionLeg[] = [
      {
        id: 'tp2',
        type: 'TP',
        entryPrice: 200,
        quantity: 1,
        entryTime: 12345,
        targetPrice: 220,
        status: 'OPEN',
      },
      {
        id: 'runner2',
        type: 'RUNNER',
        entryPrice: 200,
        quantity: 1,
        entryTime: 12345,
        status: 'OPEN',
      },
    ];

    updateAssetPositions(state, 'ETH', legs);

    expect(getTotalOpenPositions(state)).toBe(1);
  });

  it('blocks new entries while a sale is uncertain even if position capacity remains', () => {
    const state = initializeMultiAssetState(assets);
    updateAssetPositions(state, 'BTC', [{
      id: 'pending', type: 'TRADE', status: 'OPEN', entryPrice: 100, quantity: 1, entryTime: 1,
      closePending: { signature: 'unknown', reason: 'timeout', since: 2 },
    }]);
    const reloaded = JSON.parse(JSON.stringify(state));
    const config = { assets, maxPositionsPerAsset: 2, maxTotalPositions: 3, minTimeBetweenTradesMs: 0 };
    expect(canAssetTrade(reloaded, 'BTC', config, 3)).toEqual({
      canTrade: false, reason: 'BTC requires sale reconciliation',
    });
    expect(canAssetTrade(reloaded, 'ETH', config, 3).canTrade).toBe(true);
  });
});
