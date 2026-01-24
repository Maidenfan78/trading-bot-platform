import { Keypair } from '@solana/web3.js';
import { LiveBroker } from '../src/execution/LiveBroker';
import type { PositionLeg } from '../src/types';

const mockCanClosePosition = jest.fn();
const mockGetQuoteBtcToUsdc = jest.fn();
const mockValidateQuote = jest.fn();
const mockBuildSwapTransaction = jest.fn();
const mockSendAndConfirm = jest.fn();

jest.mock('../src/solana/balances', () => ({
  canTrade: jest.fn(),
  canClosePosition: (...args: any[]) => mockCanClosePosition(...args),
}));

jest.mock('../src/solana/jupiter', () => {
  return {
    JupiterClient: jest.fn().mockImplementation(() => ({
      getQuoteUsdcToBtc: jest.fn(),
      getQuoteBtcToUsdc: (...args: any[]) => mockGetQuoteBtcToUsdc(...args),
      validateQuote: (...args: any[]) => mockValidateQuote(...args),
      buildSwapTransaction: (...args: any[]) => mockBuildSwapTransaction(...args),
    })),
  };
});

jest.mock('../src/solana/wallet', () => ({
  loadWallet: jest.fn(() => Keypair.generate()),
  sendAndConfirmVersionedTransaction: (...args: any[]) => mockSendAndConfirm(...args),
}));

describe('LiveBroker closeLeg', () => {
  it('uses leg.btcMint when closing', async () => {
    mockCanClosePosition.mockResolvedValue({ canClose: true });
    mockGetQuoteBtcToUsdc.mockResolvedValue({ outAmount: '1000000', priceImpactPct: 0 });
    mockValidateQuote.mockResolvedValue(true);
    mockBuildSwapTransaction.mockResolvedValue({ mock: true });
    mockSendAndConfirm.mockResolvedValue({ success: true, signature: 'sig' });

    const broker = new LiveBroker({
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

    const leg: PositionLeg = {
      id: 'leg1',
      positionId: 'pos-1',
      type: 'TP',
      entryPrice: 100,
      quantity: 1,
      entryTime: 1,
      status: 'OPEN',
      btcMint: 'wbtc',
    };

    await broker.closeLeg(leg, { timestamp: 2, open: 0, high: 0, low: 0, close: 100, volume: 0 }, 'test');

    expect(mockCanClosePosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'wbtc',
      1,
      expect.anything(),
      undefined
    );
    expect(mockGetQuoteBtcToUsdc).toHaveBeenCalledWith(1, 'wbtc');
  });
});
