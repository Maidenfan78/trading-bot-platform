import { reconcileFilledQuantity } from '../src/execution/fillReconciliation';

describe('reconcileFilledQuantity (BUG-031)', () => {
  it('prefers the measured fill over the quote', () => {
    // 0.3% worse than quoted - ordinary slippage inside the 0.5% cap.
    const result = reconcileFilledQuantity(10, 9.97);

    expect(result.source).toBe('measured');
    expect(result.quantity).toBe(9.97);
    expect(result.warning).toBeUndefined();
  });

  it('records LESS than the quote, which is the whole point', () => {
    // Recording the quote is what made canClosePosition refuse the TP sell:
    // the leg claimed more than the wallet held, with no tolerance.
    const quoted = 10;
    const actual = 9.95;
    const result = reconcileFilledQuantity(quoted, actual);

    expect(result.quantity).toBeLessThan(quoted);
    expect(result.quantity).toBe(actual);
  });

  it('falls back to the quote when the balance could not be read', () => {
    const result = reconcileFilledQuantity(10, null);

    expect(result.source).toBe('quoted');
    expect(result.quantity).toBe(10);
    expect(result.warning).toMatch(/QUOTED/);
  });

  it('falls back when the delta is zero, as wSOL unwrapping produces', () => {
    // Jupiter can unwrap wSOL to native SOL, leaving the token account flat.
    const result = reconcileFilledQuantity(10, 0);

    expect(result.source).toBe('quoted');
    expect(result.quantity).toBe(10);
    expect(result.warning).toMatch(/wSOL|native/i);
  });

  it('falls back on a negative delta rather than recording nonsense', () => {
    const result = reconcileFilledQuantity(10, -4);

    expect(result.source).toBe('quoted');
    expect(result.quantity).toBe(10);
  });

  it('rejects an implausible delta instead of trusting it', () => {
    // Someone else's transfer landing mid-swap, or a doubled balance. Measuring
    // must not become a new way to record a wrong number.
    const result = reconcileFilledQuantity(10, 25);

    expect(result.source).toBe('quoted');
    expect(result.quantity).toBe(10);
    expect(result.warning).toMatch(/deviates/);
  });

  it('accepts deviation up to the bound and rejects beyond it', () => {
    expect(reconcileFilledQuantity(100, 91).source).toBe('measured'); // 9%
    expect(reconcileFilledQuantity(100, 89).source).toBe('quoted'); // 11%
  });

  it('honours a custom tolerance', () => {
    expect(reconcileFilledQuantity(100, 98, 0.01).source).toBe('quoted');
    expect(reconcileFilledQuantity(100, 99.5, 0.01).source).toBe('measured');
  });

  it('refuses to size a fill when the quote itself is unusable', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = reconcileFilledQuantity(bad, 5);
      expect(result.quantity).toBe(0);
      expect(result.source).toBe('quoted');
      expect(result.warning).toMatch(/not usable/);
    }
  });

  it('treats a non-finite measurement as unreadable', () => {
    expect(reconcileFilledQuantity(10, Number.NaN).source).toBe('quoted');
  });
});
