import type { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { sendAndConfirmVersionedTransaction } from '../src/solana/wallet';

/**
 * BUG-030: a confirmation timeout was reported as failure with an EMPTY
 * signature. On Solana a timeout routinely means "landed, but the RPC stopped
 * waiting", so that turned a real buy into an orphan - USDC spent, coins held,
 * no leg, no take-profit, no cost basis - and threw away the one thing needed to
 * investigate it.
 */

const SIG = '5xFakeSignatureForTests11111111111111111111111111111111111111111111';

function makeTx(): VersionedTransaction {
  return { sign: jest.fn() } as unknown as VersionedTransaction;
}

function makeConnection(overrides: Record<string, unknown>): Connection {
  return {
    sendTransaction: jest.fn().mockResolvedValue(SIG),
    confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
    getSignatureStatus: jest.fn().mockResolvedValue({ value: null }),
    ...overrides,
  } as unknown as Connection;
}

const wallet = {} as Keypair;

describe('sendAndConfirmVersionedTransaction (BUG-030)', () => {
  it('confirms normally', async () => {
    const connection = makeConnection({});

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result).toEqual({ signature: SIG, success: true });
  });

  it('treats a timed-out confirmation as SUCCESS when the chain says it landed', async () => {
    // The core of BUG-030. Before the fix this returned success:false and the
    // caller discarded a position whose coins were already in the wallet.
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('Transaction was not confirmed in 30.00 seconds')),
      getSignatureStatus: jest.fn().mockResolvedValue({
        value: { err: null, confirmationStatus: 'confirmed', confirmations: 2 },
      }),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(true);
    expect(result.signature).toBe(SIG);
  });

  it('recognises a finalized transaction reported with confirmations: null', async () => {
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('timeout')),
      getSignatureStatus: jest.fn().mockResolvedValue({
        value: { err: null, confirmationStatus: 'finalized', confirmations: null },
      }),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(true);
  });

  it('searches transaction history, or the status will have aged out', async () => {
    // A confirmation timeout is exactly when the status is no longer in the
    // RPC's recent cache, so this flag is load-bearing rather than cosmetic.
    const getSignatureStatus = jest.fn().mockResolvedValue({
      value: { err: null, confirmationStatus: 'confirmed', confirmations: 1 },
    });
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('timeout')),
      getSignatureStatus,
    });

    await sendAndConfirmVersionedTransaction(connection, makeTx(), wallet, { maxRetries: 1 });

    expect(getSignatureStatus).toHaveBeenCalledWith(SIG, { searchTransactionHistory: true });
  });

  it('reports UNRESOLVED, keeping the signature, when the fate stays unknown', async () => {
    // The regression that matters: signature must NOT be empty, and the caller
    // must be able to tell "unknown" from "definitely did not happen".
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('timeout')),
      getSignatureStatus: jest.fn().mockResolvedValue({ value: null }),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.unresolved).toBe(true);
    expect(result.signature).toBe(SIG);
    expect(result.signature).not.toBe('');
  });

  it('reports a definitive on-chain failure as failed, not unresolved', async () => {
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockResolvedValue({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.unresolved).toBeUndefined();
    expect(result.signature).toBe(SIG);
  });

  it('does not retry a transaction that executed and failed', async () => {
    // Resending the identical signature cannot succeed; retrying only burns the
    // blockhash window. Nothing moved, because Solana applies a tx atomically.
    const sendTransaction = jest.fn().mockResolvedValue(SIG);
    const connection = makeConnection({
      sendTransaction,
      confirmTransaction: jest.fn().mockResolvedValue({ value: { err: 'failed' } }),
    });

    await sendAndConfirmVersionedTransaction(connection, makeTx(), wallet, { maxRetries: 3 });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout whose status shows an error as failed', async () => {
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('timeout')),
      getSignatureStatus: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' },
      }),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.unresolved).toBeUndefined();
    expect(result.signature).toBe(SIG);
  });

  it('is not unresolved when nothing was ever sent', async () => {
    // Never reached the network, so there is nothing to reconcile - this must
    // not be confused with an orphaned buy.
    const connection = makeConnection({
      sendTransaction: jest.fn().mockRejectedValue(new Error('blockhash not found')),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.unresolved).toBeUndefined();
    expect(result.signature).toBe('');
  });

  it('survives getSignatureStatus itself throwing', async () => {
    const connection = makeConnection({
      confirmTransaction: jest.fn().mockRejectedValue(new Error('timeout')),
      getSignatureStatus: jest.fn().mockRejectedValue(new Error('RPC 429')),
    });

    const result = await sendAndConfirmVersionedTransaction(
      connection,
      makeTx(),
      wallet,
      { maxRetries: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.unresolved).toBe(true);
    expect(result.signature).toBe(SIG);
  });
});
