import {
  graduateLeg,
  retireLeg,
  getRetiredLegs,
  getOpenLegs,
  getClosedLegs,
  calculateRealizedPnL,
} from '../src/strategy/position';
import type { PositionLeg } from '../src/types';

function tradeLeg(overrides: Partial<PositionLeg> = {}): PositionLeg {
  return {
    id: 'TRADE_1',
    positionId: 'POS_1',
    type: 'TRADE',
    entryPrice: 100,
    quantity: 1,
    entryTime: 1_700_000_000_000,
    targetPrice: 130,
    status: 'OPEN',
    ...overrides,
  };
}

describe('retireLeg', () => {
  it('moves a leg to RETIRED without booking a sale', () => {
    const leg = tradeLeg();
    const retired = retireLeg(leg, { timestamp: 1_700_000_900_000, reason: 'EXPIRED' });

    expect(retired.status).toBe('RETIRED');
    expect(retired.retireTime).toBe(1_700_000_900_000);
    expect(retired.retireReason).toBe('EXPIRED');
    // Never a sale — no close data that a P&L logger could pick up.
    expect(retired.closePrice).toBeUndefined();
    expect(retired.closeTime).toBeUndefined();
    expect(retired.closeReason).toBeUndefined();
  });

  it('does not mutate the input leg', () => {
    const leg = tradeLeg();
    retireLeg(leg, { reason: 'EXPIRED' });
    expect(leg.status).toBe('OPEN');
  });

  it('keeps retired legs out of open, closed and realised P&L', () => {
    const legs = [
      retireLeg(tradeLeg({ id: 'A', entryPrice: 100, quantity: 2 }), { reason: 'TP_RESOLVED' }),
      { ...tradeLeg({ id: 'B' }), status: 'CLOSED', closePrice: 130 } as PositionLeg,
    ];

    expect(getRetiredLegs(legs).map((l) => l.id)).toEqual(['A']);
    expect(getOpenLegs(legs)).toHaveLength(0);
    expect(getClosedLegs(legs).map((l) => l.id)).toEqual(['B']);
    // Only the genuinely-sold leg contributes: (130 - 100) * 1 = 30.
    expect(calculateRealizedPnL(legs)).toBe(30);
  });
});

describe('graduateLeg', () => {
  it('converts a trade leg into a HOLD leg and strips exit tracking', () => {
    const leg = tradeLeg({ trailingStop: 120, highestPrice: 140 });
    const held = graduateLeg(leg, { timestamp: 1_700_000_900_000, reason: 'expiry' });

    expect(held.type).toBe('HOLD');
    expect(held.graduatedFrom).toBe('TRADE');
    expect(held.graduatedAt).toBe(1_700_000_900_000);
    expect(held.status).toBe('OPEN'); // graduation is not retirement
    expect(held.targetPrice).toBeUndefined();
    expect(held.trailingStop).toBeUndefined();
    expect(held.highestPrice).toBeUndefined();
  });

  it('does not mutate the input leg', () => {
    const leg = tradeLeg();
    graduateLeg(leg);
    expect(leg.type).toBe('TRADE');
    expect(leg.targetPrice).toBe(130);
  });

  it('is a passthrough copy when the leg is already HOLD', () => {
    const leg = tradeLeg({ id: 'H', type: 'HOLD', targetPrice: undefined });
    const held = graduateLeg(leg);
    expect(held).not.toBe(leg);
    expect(held.type).toBe('HOLD');
  });

  it('a graduated HOLD leg never contributes realised P&L once retired', () => {
    const held = graduateLeg(tradeLeg(), { reason: 'expiry' });
    const retired = retireLeg(held, { reason: 'EXPIRED' });
    expect(calculateRealizedPnL([retired])).toBe(0);
  });
});
