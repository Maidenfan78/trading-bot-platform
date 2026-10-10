/**
 * Decide what quantity a swap actually filled.
 *
 * Jupiter's `quote.outAmount` is the *expected* output. The executed swap can
 * fill for less - up to the configured slippage cap - so recording the quote as
 * truth overstates holdings (BUG-031). That matters far downstream: the TP sell
 * goes through `canClosePosition`, which refuses when the recorded quantity
 * exceeds the wallet balance, with no tolerance. An overstated leg therefore
 * never sells, retries that failure every cycle, and eventually graduates to
 * HOLD looking like an ordinary expiry - so the bot silently stops taking profit
 * on live while paper looks perfect.
 *
 * The fix is to measure the real delta with the *same* instrument that will
 * later check it (`getTokenBalance`), so the recorded quantity and the sell-time
 * check agree by construction rather than by luck.
 *
 * This module is the decision alone, kept pure so it can be tested without a
 * chain: callers pass the quoted amount and the measured delta.
 */

export type FillSource = 'measured' | 'quoted';

export interface FillReconciliation {
  /** The quantity to record on the legs. */
  quantity: number;
  /** Where it came from. 'quoted' means the measurement was not usable. */
  source: FillSource;
  /**
   * Set when the measurement was rejected. The caller must log this loudly:
   * the recorded quantity is an estimate, so the holdings and the cost basis
   * are approximate and may need reconciling against the wallet.
   */
  warning?: string;
}

/**
 * @param quotedQty     Quantity implied by the Jupiter quote (token units).
 * @param measuredDelta Post-swap balance minus pre-swap balance, or null when
 *                      either balance read failed.
 * @param tolerance     Fractional deviation from the quote beyond which the
 *                      measurement is treated as implausible. Default 0.1
 *                      (10%), which is 20x the 0.5% slippage cap - generous on
 *                      purpose, because its job is catching nonsense (a zero,
 *                      a double, someone else's transfer landing mid-swap), not
 *                      policing normal slippage.
 */
export function reconcileFilledQuantity(
  quotedQty: number,
  measuredDelta: number | null,
  tolerance = 0.1
): FillReconciliation {
  if (!Number.isFinite(quotedQty) || quotedQty <= 0) {
    return {
      quantity: 0,
      source: 'quoted',
      warning: `Quoted quantity is not usable (${quotedQty}); cannot size this fill.`,
    };
  }

  if (measuredDelta === null || !Number.isFinite(measuredDelta)) {
    return {
      quantity: quotedQty,
      source: 'quoted',
      warning:
        'Could not read the wallet balance around the swap, so the leg quantity is the ' +
        'QUOTED amount, not the actual fill. Holdings and cost basis are approximate - ' +
        'reconcile against the wallet.',
    };
  }

  if (measuredDelta <= 0) {
    return {
      quantity: quotedQty,
      source: 'quoted',
      warning:
        `Measured balance delta was ${measuredDelta}, which cannot be a fill. The usual ` +
        'cause is Jupiter unwrapping wSOL to native SOL, so the token account never moves. ' +
        'Falling back to the QUOTED amount - holdings and cost basis are approximate.',
    };
  }

  const deviation = Math.abs(measuredDelta - quotedQty) / quotedQty;
  if (deviation > tolerance) {
    return {
      quantity: quotedQty,
      source: 'quoted',
      warning:
        `Measured fill ${measuredDelta} deviates ${(deviation * 100).toFixed(1)}% from the ` +
        `quoted ${quotedQty}, beyond the ${(tolerance * 100).toFixed(0)}% plausibility bound. ` +
        'Falling back to the QUOTED amount - something other than slippage moved this ' +
        'balance, so reconcile against the wallet before trusting the position.',
    };
  }

  return { quantity: measuredDelta, source: 'measured' };
}
