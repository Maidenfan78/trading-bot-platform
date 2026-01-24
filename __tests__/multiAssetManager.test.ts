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
});
