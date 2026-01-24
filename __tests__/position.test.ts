import { createTwoLegPosition } from '../src/strategy/position';

describe('createTwoLegPosition', () => {
  it('assigns a shared positionId to both legs', () => {
    const legs = createTwoLegPosition(
      { type: 'LONG', timestamp: 1700000000000, price: 100, mfi: 50, atr: 2 },
      100
    );

    expect(legs).toHaveLength(2);
    expect(legs[0].positionId).toBeDefined();
    expect(legs[1].positionId).toBeDefined();
    expect(legs[0].positionId).toBe(legs[1].positionId);
  });
});
