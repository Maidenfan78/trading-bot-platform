import { PaperBroker } from '../src/execution/PaperBroker';
import type { PositionLeg } from '../src/types';

describe('PaperBroker close pricing', () => {
  it('uses leg.closePrice when provided', async () => {
    const broker = new PaperBroker({
      initialUsdcBalance: 10000,
      initialBtcBalance: 0,
      slippageBps: 0,
      tradeLegUsdc: 100,
      atrTpMultiplier: 1,
      atrTrailMultiplier: 2.5,
      breakEvenLockMultiplier: 0.25,
    });

    const leg: PositionLeg = {
      id: 'tp',
      positionId: 'pos-1',
      type: 'TP',
      entryPrice: 100,
      quantity: 1,
      entryTime: 1,
      targetPrice: 110,
      status: 'OPEN',
      closePrice: 105,
      closeReason: 'TP target hit',
    };

    await broker.closeLeg(leg, { timestamp: 2, open: 100, high: 110, low: 95, close: 120, volume: 1 }, 'TP');

    const history = broker.getTradeHistory();
    const last = history[history.length - 1];
    expect(last.price).toBe(105);
  });
});

describe('PaperBroker confirmed closes (BUG-038)', () => {
  const candle = { timestamp: 2, open: 100, high: 140, low: 95, close: 140, volume: 1 };
  const leg: PositionLeg = { id: 'trade', type: 'TRADE', status: 'OPEN',
    entryPrice: 100, quantity: 1, entryTime: 1, targetPrice: 130 };
  const broker = () => new PaperBroker({ initialUsdcBalance: 1000, initialBtcBalance: 2,
    slippageBps: 50, tradeLegUsdc: 100 });

  it('returns the actual fill and refuses to sell the same leg twice', async () => {
    const b = broker();
    expect(await b.closeLeg(leg, candle, 'TP')).toEqual({
      success: true, inputAmount: 1, outputAmount: 139.3, executionPrice: 139.3, executedAt: 2,
    });
    expect(b.getAccount()).toMatchObject({ btcBalance: 1, usdcBalance: 1139.3 });
    expect((await b.closeLeg(leg, candle, 'TP')).success).toBe(false);
    expect(b.getTradeHistory()).toHaveLength(1);
    expect(b.getTradeHistory()[0].action).toBe('CLOSE_TP');
  });

  it.each(['CLOSED', 'RETIRED'] as const)('refuses terminal leg %s without changing cash', async status => {
    const b = broker();
    expect((await b.closeLeg({ ...leg, status }, candle, 'TP')).success).toBe(false);
    expect(b.getAccount()).toMatchObject({ usdcBalance: 1000, btcBalance: 2 });
  });

  it('leaves balances unchanged when slippage breaches minimum proceeds', async () => {
    const b = broker();
    expect((await b.closeLeg(leg, candle, 'TP', { minOutputUsdc: 140 })).success).toBe(false);
    expect(b.getAccount()).toMatchObject({ usdcBalance: 1000, btcBalance: 2 });
    expect(b.getTradeHistory()).toHaveLength(0);
  });

  it('the legacy TP update helper also executes before marking closed', async () => {
    const b = broker();
    const updated = await b.updateAndClosePositions([{ ...leg, type: 'TP' }], candle, 10);
    expect(updated[0].status).toBe('CLOSED');
    expect(b.getTradeHistory()).toHaveLength(1);
    expect(updated[0].closePrice).toBe(b.getTradeHistory()[0].price);
    expect(b.getAccount().btcBalance).toBe(1);
  });
});
