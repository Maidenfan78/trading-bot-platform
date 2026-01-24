import { PublicKey } from '@solana/web3.js';
import { getTokenBalance } from '../src/solana/balances';

jest.mock('@solana/spl-token', () => {
  return {
    getAccount: jest.fn(),
    getAssociatedTokenAddress: jest.fn(),
    getMint: jest.fn(),
    TOKEN_PROGRAM_ID: 'TokenProgram',
  };
});

const splToken = jest.requireMock('@solana/spl-token') as {
  getAccount: jest.Mock;
  getAssociatedTokenAddress: jest.Mock;
  getMint: jest.Mock;
};

describe('getTokenBalance decimals', () => {
  it('caches mint decimals from chain', async () => {
    const connection = {} as any;
    const wallet = new PublicKey('11111111111111111111111111111111');
    const mint = new PublicKey('So11111111111111111111111111111111111111112');

    splToken.getAssociatedTokenAddress.mockResolvedValue(mint);
    splToken.getAccount.mockResolvedValue({ amount: BigInt(1000) });
    splToken.getMint.mockResolvedValue({ decimals: 3 });

    const first = await getTokenBalance(connection, wallet, mint);
    const second = await getTokenBalance(connection, wallet, mint);

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(splToken.getMint).toHaveBeenCalledTimes(1);
  });
});
