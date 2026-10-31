import type { Broker } from '../core/Broker';
import type { Candle, PositionLeg } from '../types';

/** Legacy policy helpers propose CLOSED legs; execution must still receive OPEN legs. */
export async function executeCloseIntent(
  broker: Pick<Broker, 'closeLeg'>,
  original: PositionLeg,
  intent: PositionLeg,
  candle: Candle,
  reason: string
): Promise<PositionLeg> {
  if (original.closePending) return { ...original };
  try {
    const result = await broker.closeLeg({ ...original, closePrice: intent.closePrice }, candle, reason);
    const invalidFill = result?.success && (
      result.inputAmount !== original.quantity ||
      !Number.isFinite(result.outputAmount) || result.outputAmount <= 0 ||
      !Number.isFinite(result.executedAt) || result.executedAt <= 0
    );
    if (!result || invalidFill || (!result.success && result.unresolved)) {
      return {
        ...original,
        closePending: {
          signature: result?.signature,
          reason: result && !result.success ? result.error : 'Broker returned no valid sale fill',
          since: Date.now(),
        },
      };
    }
    if (!result.success) return { ...original };
    return {
      ...intent,
      closePrice: result.outputAmount / result.inputAmount,
      closeTime: result.executedAt,
    };
  } catch (error) {
    return { ...original, closePending: { reason: String(error), since: Date.now() } };
  }
}
