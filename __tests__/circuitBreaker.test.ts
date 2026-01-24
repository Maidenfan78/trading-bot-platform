import { CircuitBreaker } from '../src/execution/CircuitBreaker';

describe('CircuitBreaker daily reset', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets daily counters when date changes', () => {
    jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    const breaker = new CircuitBreaker({
      maxDailyLossPct: 5,
      maxConsecutiveLosses: 3,
      maxDailyTrades: 10,
      minTimeBetweenTradesMs: 0,
      maxPriceDeviationPct: 5,
    });

    breaker.recordTrade(10, 1000);
    const before = breaker.getState();
    expect(before.tradesExecutedToday).toBe(1);
    expect(before.dailyPnl).toBe(10);

    jest.setSystemTime(new Date('2024-01-02T00:01:00Z'));
    breaker.resetDaily();

    const after = breaker.getState();
    expect(after.tradesExecutedToday).toBe(0);
    expect(after.dailyPnl).toBe(0);
    expect(after.resetDate).toBe('2024-01-02');
  });

  it('does not reset counters on the same day', () => {
    jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    const breaker = new CircuitBreaker({
      maxDailyLossPct: 5,
      maxConsecutiveLosses: 3,
      maxDailyTrades: 10,
      minTimeBetweenTradesMs: 0,
      maxPriceDeviationPct: 5,
    });

    breaker.recordTrade(10, 1000);
    breaker.resetDaily();

    const state = breaker.getState();
    expect(state.tradesExecutedToday).toBe(1);
    expect(state.dailyPnl).toBe(10);
    expect(state.resetDate).toBe('2024-01-01');
  });
});
