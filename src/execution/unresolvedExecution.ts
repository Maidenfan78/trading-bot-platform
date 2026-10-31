/**
 * A buy that may have executed on-chain but whose outcome this process could
 * not establish (BUG-047). Returning `null` would tell the caller "nothing was
 * spent", which is exactly what must not be assumed: the caller has to keep
 * its cash/exposure claim and quarantine trading until chain evidence settles it.
 */
export interface UnresolvedExecutionEvidence {
  /** Transaction signature, when one was produced. Deterministic once signed. */
  signature?: string;
  /** Blockhash the transaction was built against; lets a resolver prove expiry. */
  recentBlockhash?: string;
  mint?: string;
  usdcCommitted?: number;
  /** The transaction is known to have landed; only its fill is unknown. */
  landed?: boolean;
}

export class UnresolvedExecutionError extends Error {
  readonly unresolvedExecution = true as const;

  constructor(message: string, readonly evidence: UnresolvedExecutionEvidence) {
    super(message);
    this.name = 'UnresolvedExecutionError';
  }
}

/** Duck-typed so a consumer with its own module instance still recognises it. */
export function isUnresolvedExecutionError(error: unknown): error is UnresolvedExecutionError {
  return error !== null && typeof error === 'object' &&
    (error as { unresolvedExecution?: unknown }).unresolvedExecution === true &&
    typeof (error as { evidence?: unknown }).evidence === 'object';
}
