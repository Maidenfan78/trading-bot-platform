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
