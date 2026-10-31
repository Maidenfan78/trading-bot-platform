import { Connection, Keypair } from '@solana/web3.js';
import { LiveBroker } from '../src/execution/LiveBroker';
import { isUnresolvedExecutionError } from '../src/execution/unresolvedExecution';
import type { UnresolvedExecutionError } from '../src/execution/unresolvedExecution';
import bs58 from 'bs58';
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
const mockGetTransaction = jest.fn();
const mockWallet = Keypair.generate();
jest.spyOn(Connection.prototype, 'getTransaction').mockImplementation((...args: any[]) => mockGetTransaction(...args));

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
  loadWallet: jest.fn(() => mockWallet),
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
  mockGetTransaction.mockResolvedValue({
    blockTime: 1700000000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: 'usdc', owner: mockWallet.publicKey.toBase58(),
        uiTokenAmount: { amount: '1000000000', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint: 'usdc', owner: mockWallet.publicKey.toBase58(),
        uiTokenAmount: { amount: '1001250000', decimals: 6 } }],
    },
  });
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
      expect(leg.entrySignature).toBe('sig');
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
    expect(result).toEqual({ success: false, error: 'No mint recorded on leg' });
    expect(mockCanClosePosition).not.toHaveBeenCalled();
    expect(mockGetQuoteTokenToUsdc).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});

describe('LiveBroker explicit close execution contract (BUG-038)', () => {
  const leg: PositionLeg = {
    id: 'sale', type: 'TRADE', status: 'OPEN', mint: JUP, decimals: 6,
    entryPrice: 1, quantity: 1, entryTime: 1,
  };
  const quote = () => ({ outAmount: '1400000', priceImpactPct: 0,
    route: { otherAmountThreshold: '1200000', swapMode: 'ExactIn' } });

  beforeEach(() => mockGetQuoteTokenToUsdc.mockResolvedValue(quote()));

  it('returns confirmed transaction proceeds rather than the quoted output', async () => {
    const result = await makeBroker().closeLeg(leg, candle, 'TP');
    expect(result).toEqual({ success: true, signature: 'sig', inputAmount: 1,
      outputAmount: 1.25, executionPrice: 1.25, executedAt: 1700000000000 });
    expect(mockGetTransaction).toHaveBeenCalledWith('sig', {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
  });

  it.each(['CLOSED', 'RETIRED'] as const)('does not submit a %s leg', async status => {
    expect((await makeBroker().closeLeg({ ...leg, status }, candle, 'TP')).success).toBe(false);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it('does not resubmit a leg awaiting reconciliation', async () => {
    const result = await makeBroker().closeLeg({ ...leg,
      closePending: { signature: 'earlier', reason: 'timeout', since: 1 } }, candle, 'TP');
    expect(result.success).toBe(false);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it.each(['balance', 'quote', 'validation', 'build', 'exception'])('returns explicit pre-send failure: %s', async stage => {
    if (stage === 'balance') mockCanClosePosition.mockResolvedValue({ canClose: false, reason: 'insufficient' });
    if (stage === 'quote') mockGetQuoteTokenToUsdc.mockResolvedValue(null);
    if (stage === 'validation') mockValidateQuote.mockResolvedValue(false);
    if (stage === 'build') mockBuildSwapTransaction.mockResolvedValue(null);
    if (stage === 'exception') mockCanClosePosition.mockRejectedValue(new Error('RPC down'));
    const result = await makeBroker().closeLeg(leg, candle, 'TP');
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(result).not.toMatchObject({ unresolved: true });
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it('distinguishes definitive chain failure from uncertain execution', async () => {
    mockSendAndConfirm.mockResolvedValueOnce({ success: false, signature: 'failed', error: 'chain failure' });
    expect(await makeBroker().closeLeg(leg, candle, 'TP')).toMatchObject({
      success: false, signature: 'failed', error: 'chain failure',
    });
    mockSendAndConfirm.mockResolvedValueOnce({ success: false, unresolved: true, signature: 'unknown', error: 'timeout' });
    expect(await makeBroker().closeLeg(leg, candle, 'TP')).toMatchObject({
      success: false, signature: 'unknown', unresolved: true,
    });
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('keeps the signature and uncertainty when fill lookup fails after confirmation', async () => {
    mockGetTransaction.mockRejectedValue(new Error('RPC unavailable'));
    expect(await makeBroker().closeLeg(leg, candle, 'TP')).toMatchObject({
      success: false, signature: 'sig', unresolved: true,
    });
  });

  it.each([null, { meta: null }, { meta: { err: null, preTokenBalances: [], postTokenBalances: [] } }])(
    'does not invent sale proceeds when transaction evidence is missing: %j', async tx => {
      mockGetTransaction.mockResolvedValue(tx);
      expect(await makeBroker().closeLeg(leg, candle, 'TP')).toMatchObject({
        success: false, signature: 'sig', unresolved: true,
      });
    }
  );

  it('treats a throw during submission as uncertain, never a safe-to-retry failure', async () => {
    mockSendAndConfirm.mockRejectedValue(new Error('connection dropped'));
    expect(await makeBroker().closeLeg(leg, candle, 'TP')).toMatchObject({ success: false, unresolved: true });
  });

  it('rejects a quote below the required TP proceeds without submitting', async () => {
    const result = await makeBroker().closeLeg(leg, candle, 'TP', { minOutputUsdc: 2 });
    expect(result.success).toBe(false);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it('raises the transaction minimum output while preserving a stricter existing threshold', async () => {
    await makeBroker().closeLeg(leg, candle, 'TP', { minOutputUsdc: 1.25 });
    expect(mockBuildSwapTransaction.mock.calls[0][0].route.otherAmountThreshold).toBe('1250000');
    mockGetQuoteTokenToUsdc.mockResolvedValue({ ...quote(), route: {
      otherAmountThreshold: '1300000', swapMode: 'ExactIn',
    } });
    await makeBroker().closeLeg(leg, candle, 'TP', { minOutputUsdc: 1.25 });
    expect(mockBuildSwapTransaction.mock.calls[1][0].route.otherAmountThreshold).toBe('1300000');
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

describe('LiveBroker unresolved buy contract (BUG-047)', () => {
  const weth = { symbol: 'wETH', mint: WETH, decimals: 8 };
  const signedTx = () => ({ signatures: [Uint8Array.from([7, 8, 9])], message: { recentBlockhash: 'blockhash-1' } });

  beforeEach(() => {
    mockGetQuoteUsdcToToken.mockResolvedValue({ quote: { outAmount: '8000000', priceImpactPct: 0 }, mint: WETH, decimals: 8 });
    mockBuildSwapTransaction.mockResolvedValue(signedTx());
  });

  async function openError(): Promise<unknown> {
    try {
      await makeBroker().openPosition(longSignal, candle, weth);
    } catch (error) {
      return error;
    }
    throw new Error('expected openPosition to throw');
  }

  it('throws with the signature, blockhash and committed spend when the send never resolves', async () => {
    mockSendAndConfirm.mockResolvedValue({ success: false, unresolved: true, signature: 'pending-sig', error: 'timeout' });
    const error = await openError();
    expect(isUnresolvedExecutionError(error)).toBe(true);
    expect((error as UnresolvedExecutionError).evidence).toEqual({
      signature: 'pending-sig', recentBlockhash: 'blockhash-1', mint: WETH, usdcCommitted: 200,
    });
  });

  it('derives the signature locally when no send reply arrived', async () => {
    mockSendAndConfirm.mockResolvedValue({ success: false, signature: '', error: 'socket hang up' });
    const error = await openError() as UnresolvedExecutionError;
    expect(error.evidence.signature).toBe(bs58.encode(Uint8Array.from([7, 8, 9])));
  });

  it('treats a throw during submission as unresolved, not as no spend', async () => {
    mockSendAndConfirm.mockRejectedValue(new Error('connection dropped'));
    const error = await openError() as UnresolvedExecutionError;
    expect(isUnresolvedExecutionError(error)).toBe(true);
    expect(error.evidence).toMatchObject({ recentBlockhash: 'blockhash-1', mint: WETH });
  });

  it('marks a confirmed swap with no usable fill quantity as landed', async () => {
    mockGetQuoteUsdcToToken.mockResolvedValue({ quote: { outAmount: '0', priceImpactPct: 0 }, mint: WETH, decimals: 8 });
    const error = await openError() as UnresolvedExecutionError;
    expect(error.evidence).toMatchObject({ signature: 'sig', landed: true });
  });

  it('returns null for a definitive on-chain failure: nothing was spent', async () => {
    mockSendAndConfirm.mockResolvedValue({ success: false, signature: 'failed-sig', error: 'Transaction failed' });
    await expect(makeBroker().openPosition(longSignal, candle, weth)).resolves.toBeNull();
  });

  it.each(['quote', 'validation', 'build', 'exception'])('returns null before submission: %s', async stage => {
    if (stage === 'quote') mockGetQuoteUsdcToToken.mockResolvedValue(null);
    if (stage === 'validation') mockValidateQuote.mockResolvedValue(false);
    if (stage === 'build') mockBuildSwapTransaction.mockResolvedValue(null);
    if (stage === 'exception') mockCanTradeAsset.mockRejectedValue(new Error('RPC down'));
    await expect(makeBroker().openPosition(longSignal, candle, weth)).resolves.toBeNull();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});
