import { Keypair } from '@solana/web3.js';
import { LiveBroker } from '../src/execution/LiveBroker';
import type { PositionLeg } from '../src/types';

const mockCanTrade = jest.fn();
const mockCanTradeAsset = jest.fn();
const mockCanClosePosition = jest.fn();
const mockGetQuoteUsdcToBtc = jest.fn();
const mockGetQuoteUsdcToToken = jest.fn();
const mockGetQuoteBtcToUsdc = jest.fn();
const mockGetQuoteTokenToUsdc = jest.fn();
const mockValidateQuote = jest.fn();
const mockBuildSwapTransaction = jest.fn();
const mockSendAndConfirm = jest.fn();

jest.mock('../src/solana/balances', () => ({
  canTrade: (...args: any[]) => mockCanTrade(...args),
  canTradeAsset: (...args: any[]) => mockCanTradeAsset(...args),
  canClosePosition: (...args: any[]) => mockCanClosePosition(...args),
}));

jest.mock('../src/solana/jupiter', () => {
  return {
    JupiterClient: jest.fn().mockImplementation(() => ({
      getQuoteUsdcToBtc: (...args: any[]) => mockGetQuoteUsdcToBtc(...args),
      getQuoteUsdcToToken: (...args: any[]) => mockGetQuoteUsdcToToken(...args),
      getQuoteBtcToUsdc: (...args: any[]) => mockGetQuoteBtcToUsdc(...args),
      getQuoteTokenToUsdc: (...args: any[]) => mockGetQuoteTokenToUsdc(...args),
      validateQuote: (...args: any[]) => mockValidateQuote(...args),
      buildSwapTransaction: (...args: any[]) => mockBuildSwapTransaction(...args),
    })),
  };
});

jest.mock('../src/solana/wallet', () => ({
  loadWallet: jest.fn(() => Keypair.generate()),
  sendAndConfirmVersionedTransaction: (...args: any[]) => mockSendAndConfirm(...args),
}));

const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const candle = { timestamp: 2, open: 0, high: 0, low: 0, close: 100, volume: 0 };

function makeBroker() {
  return new LiveBroker({
    rpcUrl: 'http://localhost',
    walletSecretKey: 'test',
    usdcMint: 'usdc',
    cbBtcMint: 'cb',
    wbtcMint: 'wbtc',
    slippageBps: 50,
    tradeLegUsdc: 100,
    atrTpMultiplier: 1,
    atrTrailMultiplier: 2.5,
    minBtcBalance: 0,
    minUsdcReserve: 0,
    maxPriceImpactBps: 100,
  });
}

const longSignal = {
  type: 'LONG' as const,
  entryPrice: 100,
  targetPrice: 110,
  atr: 5,
  timestamp: 1,
  mfi: 20,
  price: 100,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCanTrade.mockResolvedValue({ canTrade: true, usdc: 1000, btc: 0 });
  mockCanTradeAsset.mockResolvedValue({ canTrade: true, usdc: 1000, asset: 0 });
  mockCanClosePosition.mockResolvedValue({ canClose: true });
  mockValidateQuote.mockResolvedValue(true);
  mockBuildSwapTransaction.mockResolvedValue({ mock: true });
  mockSendAndConfirm.mockResolvedValue({ success: true, signature: 'sig' });
});

describe('LiveBroker asset routing (BUG-025)', () => {
  it('quotes the named asset mint, never the configured BTC mint', async () => {
    mockGetQuoteUsdcToToken.mockResolvedValue({
      quote: { outAmount: '81449620', priceImpactPct: 0 },
      mint: WETH,
      decimals: 8,
    });

    const broker = makeBroker();
    await broker.openPosition(longSignal, candle, { symbol: 'wETH', mint: WETH, decimals: 8 });

    expect(mockGetQuoteUsdcToToken).toHaveBeenCalledWith(200, WETH, 8);
    // The old code called this unconditionally and filled a wETH signal with BTC.
    expect(mockGetQuoteUsdcToBtc).not.toHaveBeenCalled();
  });

  it('records the asset mint on every leg it opens', async () => {
    mockGetQuoteUsdcToToken.mockResolvedValue({
      quote: { outAmount: '904939490', priceImpactPct: 0 },
      mint: JUP,
      decimals: 6,
    });

    const broker = makeBroker();
    const legs = await broker.openPosition(longSignal, candle, {
      symbol: 'JUP',
      mint: JUP,
      decimals: 6,
    });

    expect(legs).not.toBeNull();
    for (const leg of legs!) {
      expect(leg.mint).toBe(JUP);
      expect(leg.decimals).toBe(6);
    }
  });

  it('keeps the legacy cbBTC/WBTC path when no asset is named', async () => {
    mockGetQuoteUsdcToBtc.mockResolvedValue({
      quote: { outAmount: '255450', priceImpactPct: 0 },
      btcMint: 'wbtc',
    });

    const broker = makeBroker();
    await broker.openPosition(longSignal, candle);

    expect(mockGetQuoteUsdcToBtc).toHaveBeenCalledWith(200);
    expect(mockGetQuoteUsdcToToken).not.toHaveBeenCalled();
  });
});

describe('LiveBroker fill scaling (BUG-026)', () => {
  // Real figures from Jupiter for 200 USDC in, captured 2026-08-25.
  it('scales a 6-decimal fill by 1e6, not 1e8', async () => {
    mockGetQuoteUsdcToToken.mockResolvedValue({
      quote: { outAmount: '904939490', priceImpactPct: 0 },
      mint: JUP,
      decimals: 6,
    });

    const broker = makeBroker();
    const legs = await broker.openPosition(longSignal, candle, {
      symbol: 'JUP',
      mint: JUP,
      decimals: 6,
    });

    // 904939490 / 1e6 = 904.93949 JUP. The old /1e8 gave 9.0493949 - 100x short,
    // and priced JUP at $22.10 instead of $0.22.
    const totalQty = legs!.reduce((sum, leg) => sum + leg.quantity, 0);
    expect(totalQty).toBeCloseTo(904.93949, 4);
    for (const leg of legs!) {
      expect(leg.entryPrice).toBeCloseTo(0.221, 3);
    }
  });

  it('scales a 9-decimal fill by 1e9, not 1e8', async () => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    mockGetQuoteUsdcToToken.mockResolvedValue({
      quote: { outAmount: '2061900000', priceImpactPct: 0 },
      mint: WSOL,
      decimals: 9,
    });

    const broker = makeBroker();
    const legs = await broker.openPosition(longSignal, candle, {
      symbol: 'SOL',
      mint: WSOL,
      decimals: 9,
    });

    // 2061900000 / 1e9 = 2.0619 SOL at ~$97. The old /1e8 gave 20.619 - 10x over,
    // and priced SOL at $9.70.
    const totalQty = legs!.reduce((sum, leg) => sum + leg.quantity, 0);
    expect(totalQty).toBeCloseTo(2.0619, 4);
    for (const leg of legs!) {
      expect(leg.entryPrice).toBeCloseTo(97.0, 1);
    }
  });
});

describe('LiveBroker closeLeg mint resolution (BUG-027)', () => {
  const baseLeg: PositionLeg = {
    id: 'leg1',
    positionId: 'pos-1',
    type: 'TRADE',
    entryPrice: 100,
    quantity: 1,
    entryTime: 1,
    status: 'OPEN',
  };

  it('sells the leg mint with the leg decimals', async () => {
    mockGetQuoteTokenToUsdc.mockResolvedValue({ outAmount: '1000000', priceImpactPct: 0 });

    const broker = makeBroker();
    await broker.closeLeg(
      { ...baseLeg, asset: 'JUP', mint: JUP, decimals: 6 },
      candle,
      'test'
    );

    expect(mockGetQuoteTokenToUsdc).toHaveBeenCalledWith(1, JUP, 6);
    expect(mockCanClosePosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      JUP,
      1,
      expect.anything(),
      undefined,
      // The leg's symbol has to reach the guard, or it falls back to the
      // BTC-shaped reserve and names the mint in the rejection (BUG-032).
      'JUP'
    );
  });

  it('still honours the legacy btcMint field on old legs', async () => {
    mockGetQuoteTokenToUsdc.mockResolvedValue({ outAmount: '1000000', priceImpactPct: 0 });

    const broker = makeBroker();
    await broker.closeLeg({ ...baseLeg, btcMint: 'wbtc' }, candle, 'test');

    expect(mockGetQuoteTokenToUsdc).toHaveBeenCalledWith(1, 'wbtc', 8);
  });

  it('refuses to close a leg with no mint instead of falling back to BTC', async () => {
    const broker = makeBroker();
    const result = await broker.closeLeg(baseLeg, candle, 'test');

    // The old code resolved cbBtcMint here and sold BTC for real.
    expect(result).toBeUndefined();
    expect(mockCanClosePosition).not.toHaveBeenCalled();
    expect(mockGetQuoteTokenToUsdc).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});

describe('LiveBroker balance checks (BUG-028)', () => {
  it('checks the traded asset mint, not just USDC/cbBTC/WBTC', async () => {
    mockGetQuoteUsdcToToken.mockResolvedValue({
      quote: { outAmount: '81449620', priceImpactPct: 0 },
      mint: WETH,
      decimals: 8,
    });

    const broker = makeBroker();
    await broker.openPosition(longSignal, candle, { symbol: 'wETH', mint: WETH, decimals: 8 });

    expect(mockCanTradeAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'usdc',
      WETH,
      100,
      expect.anything(),
      undefined
    );
    expect(mockCanTrade).not.toHaveBeenCalled();
  });

  it('aborts the buy when the asset balance check fails', async () => {
    mockCanTradeAsset.mockResolvedValue({
      canTrade: false,
      reason: 'Insufficient USDC',
      usdc: 0,
      asset: 0,
    });

    const broker = makeBroker();
    const legs = await broker.openPosition(longSignal, candle, {
      symbol: 'wETH',
      mint: WETH,
      decimals: 8,
    });

    expect(legs).toBeNull();
    expect(mockGetQuoteUsdcToToken).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});
