import { Keypair } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { confirmedSaleProceeds } from '../src/execution/saleProceeds';

const wallet = Keypair.generate().publicKey;
function balance(amount: string, owner = wallet.toBase58(), mint = 'usdc', accountIndex = 1) {
  return { owner, mint, accountIndex, uiTokenAmount: { amount, decimals: 6 } };
}
function connection(pre: unknown[], post: unknown[], err: unknown = null) {
  return { getTransaction: jest.fn().mockResolvedValue({
    blockTime: 1700000000, meta: { err, preTokenBalances: pre, postTokenBalances: post },
  }) } as unknown as Connection;
}

describe('confirmed transaction sale proceeds', () => {
  it('sums owned USDC accounts and excludes other owners and other mints', async () => {
    const c = connection(
      [balance('1000000'), balance('2000000', wallet.toBase58(), 'usdc', 2), balance('0', 'other')],
      [balance('3000000'), balance('3000000', wallet.toBase58(), 'usdc', 2),
        balance('999999999', 'other'), balance('999999999', wallet.toBase58(), 'not-usdc')]
    );
    expect(await confirmedSaleProceeds(c, 'sig', wallet, 'usdc')).toEqual({ usdc: 3, executedAt: 1700000000000 });
  });

  it('counts proceeds paid into a newly created token account', async () => {
    expect(await confirmedSaleProceeds(connection([], [balance('130500000')]), 'sig', wallet, 'usdc'))
      .toMatchObject({ usdc: 130.5 });
  });

  it.each([
    [[], []],
    [[balance('2000000')], [balance('1000000')]],
    [[], [{ ...balance('1000000'), owner: undefined }]],
    [[], [{ ...balance('1000000'), uiTokenAmount: { amount: '1000000', decimals: 8 } }]],
    [[], [balance('NaN')]],
    [[], [balance('9007199254740992')]],
  ])('rejects ambiguous, nonpositive or unsafe proceeds: %j / %j', async (pre, post) => {
    expect(await confirmedSaleProceeds(connection(pre, post), 'sig', wallet, 'usdc')).toBeNull();
  });

  it('does not book a chain-failed transaction', async () => {
    expect(await confirmedSaleProceeds(connection([], [balance('1000000')], { error: 'failed' }), 'sig', wallet, 'usdc'))
      .toBeNull();
  });
});
