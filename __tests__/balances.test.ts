import { PublicKey } from '@solana/web3.js';
import { getTokenBalance, canClosePosition } from '../src/solana/balances';

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

describe('canClosePosition sell reserve (BUG-032)', () => {
  const WBTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
  const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const wallet = new PublicKey('11111111111111111111111111111111');
  const config = { minBtcBalance: 0.001, minUsdcReserve: 50 };

  /** Give the wallet exactly `balance` of the mint, whatever its decimals. */
  function walletHolding(balance: number) {
    splToken.getAssociatedTokenAddress.mockResolvedValue(
      new PublicKey('11111111111111111111111111111111')
    );
    splToken.getMint.mockResolvedValue({ decimals: 0 });
    splToken.getAccount.mockResolvedValue({ amount: BigInt(balance) });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps minBtcBalance back for BTC', async () => {
    walletHolding(1);
    // 1 BTC held, 1 BTC wanted, 0.001 reserved -> 0.999 available, so refuse.
    const res = await canClosePosition({} as any, wallet, WBTC, 1, config, undefined, 'WBTC');
    expect(res.canClose).toBe(false);
    expect(res.reason).toContain('Insufficient WBTC');
    expect(res.reason).toContain('keeping 0.001 WBTC minimum');
  });

  it('does not apply the BTC floor to a non-BTC asset', async () => {
    walletHolding(1);
    // The same shape in JUP must succeed: 0.001 is a BTC-denominated number and
    // withholding it from JUP is what BUG-032 was.
    const res = await canClosePosition({} as any, wallet, JUP, 1, config, undefined, 'JUP');
    expect(res.canClose).toBe(true);
  });

  it('honours an explicit per-asset floor over the BTC one', async () => {
    walletHolding(1);
    const res = await canClosePosition(
      {} as any,
      wallet,
      JUP,
      1,
      { ...config, minAssetBalance: { JUP: 0.5 } },
      undefined,
      'JUP'
    );
    expect(res.canClose).toBe(false);
    expect(res.reason).toContain('keeping 0.5 JUP minimum');
  });

  it('still refuses to sell more than the wallet holds, with no floor at all', async () => {
    walletHolding(1);
    // The hold leg's protection does not come from the floor - it comes from
    // never asking to sell more than the trade leg's quantity.
    const res = await canClosePosition({} as any, wallet, JUP, 2, config, undefined, 'JUP');
    expect(res.canClose).toBe(false);
    expect(res.reason).not.toContain('keeping');
  });

  it('falls back to the mint in the message when no symbol is passed', async () => {
    walletHolding(0);
    const res = await canClosePosition({} as any, wallet, JUP, 1, config);
    expect(res.canClose).toBe(false);
    expect(res.reason).toContain(`Insufficient ${JUP}`);
  });
});
