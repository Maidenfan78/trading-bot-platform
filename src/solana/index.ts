/**
 * Solana Module
 *
 * Exports Solana/Jupiter DEX integration utilities.
 */

// Jupiter DEX
export {
  JupiterClient,
  getExecutionPrice,
  type JupiterConfig,
} from './jupiter';

// Wallet & Transactions
export {
  loadWallet,
  sendAndConfirmVersionedTransaction,
  simulateVersionedTransaction,
  getRecentBlockhash,
  checkRPCHealth,
  parseTransactionError,
} from './wallet';

// Balance Management
export {
  getTokenBalance,
  getAllBalances,
  canTrade,
  canClosePosition,
  getBalanceSummary,
  type BalanceConfig,
} from './balances';
