import type { Connection, PublicKey, TokenBalance } from '@solana/web3.js';

/** Transaction-scoped proceeds avoid counting another bot's concurrent wallet activity. */
export async function confirmedSaleProceeds(
  connection: Connection,
  signature: string,
  wallet: PublicKey,
  usdcMint: string
): Promise<{ usdc: number; executedAt: number } | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta || tx.meta.err || !tx.meta.preTokenBalances || !tx.meta.postTokenBalances) {
    return null;
  }
  const owner = wallet.toBase58();
  const sum = (balances: TokenBalance[]): bigint | null => {
    let total = 0n;
    for (const balance of balances) {
      if (balance.mint !== usdcMint) continue;
      // Missing ownership is ambiguous: it must not be interpreted as zero.
      if (!balance.owner) return null;
      if (balance.owner !== owner) continue;
      if (balance.uiTokenAmount.decimals !== 6) return null;
      const amount = balance.uiTokenAmount.amount;
      if (!/^\d+$/.test(amount)) return null;
      total += BigInt(amount);
    }
    return total;
  };
  const before = sum(tx.meta.preTokenBalances);
  const after = sum(tx.meta.postTokenBalances);
  if (before === null || after === null) return null;
  const received = after - before;
  if (received <= 0n || received > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const executedAt = tx.blockTime === null || tx.blockTime === undefined ? Date.now() : tx.blockTime * 1000;
  return { usdc: Number(received) / 1_000_000, executedAt };
}
