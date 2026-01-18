# trading-bot-platform

A multi-indicator, multi-asset trading bot framework for Solana. Trade on Jupiter DEX with customizable strategies.

## Features

- **Multiple Indicators**: MFI, ATR, TCF2, KPSS, TDFI, DSS-MOM
- **Multi-Asset Trading**: Trade multiple assets with position limits per asset
- **Two-Leg Positions**: Take-profit leg + trailing stop runner
- **Paper & Live Trading**: Test strategies safely before going live
- **Continuous Mode**: 24/7 operation with candle-based execution
- **Dashboard**: Real-time monitoring UI (optional)
- **CSV Logging**: Detailed trade history for analysis

## Installation

```bash
npm install trading-bot-platform
```

Or link locally for development:

```bash
npm link ../trading-bot-platform
```

## Quick Start

```typescript
import {
  BinanceFetcher,
  calculateMFISeries,
  calculateATRSeries,
  generateSignal,
  isValidSignal,
  PaperBroker,
  createLogger,
} from 'trading-bot-platform';

// Create logger
const log = createLogger({
  botId: 'my-bot',
  logDir: 'logs',
  logLevel: 'info',
});

// Fetch candles
const fetcher = new BinanceFetcher({ symbol: 'BTCUSDT', interval: '4h' });
const candles = await fetcher.fetchCandles(100);

// Calculate indicators
const mfi = calculateMFISeries(candles, 14);
const atr = calculateATRSeries(candles, 14);

// Generate signal
const signal = generateSignal(
  mfi[mfi.length - 2],    // previous MFI
  mfi[mfi.length - 1],    // current MFI
  candles[candles.length - 1].close,
  atr[atr.length - 1],
  Date.now(),
  20,  // buy level
  80   // sell level
);

if (isValidSignal(signal)) {
  log.info(`Signal: ${signal.type}`);
}
```

## Module Structure

```
trading-bot-platform/
├── src/
│   ├── index.ts           # Main exports
│   ├── types/             # Type definitions
│   ├── core/              # Logger, StateManager, Broker interfaces
│   ├── indicators/        # MFI, ATR, TCF2, KPSS, TDFI, DSS-MOM
│   ├── strategy/          # Signal detection, position management
│   ├── execution/         # PaperBroker, LiveBroker, CircuitBreaker
│   ├── solana/            # Jupiter client, wallet, balances
│   ├── data/              # BinanceFetcher
│   ├── multi-asset/       # Multi-asset position manager
│   ├── utils/             # Environment, CSV logging
│   └── dashboard/         # Express + Socket.IO dashboard (optional)
└── dist/                  # Compiled output
```

## API Reference

### Core

```typescript
// Logger
import { createLogger, Logger } from 'trading-bot-platform';

const log = createLogger({
  botId: 'my-bot',
  logDir: 'logs',
  logLevel: 'info',        // 'debug' | 'info' | 'warn' | 'error'
  logFile: 'logs/bot.log',
  errorLogFile: 'logs/error.log',
});

// State Manager
import { StateManager } from 'trading-bot-platform';

const state = new StateManager<MyState>('state.json');
const data = await state.load();
await state.save(data);
```

### Indicators

```typescript
import {
  // MFI (Money Flow Index)
  calculateMFISeries,
  detectMFICross,

  // ATR (Average True Range)
  calculateATRSeries,
  updateTrailingStop,

  // TCF2 (Trend Continuation Factor 2)
  calculateTCF2Series,
  getTCF2Signal,

  // KPSS (Kase Permission Stochastic Smoothed)
  calculateKPSSSeries,
  getKPSSSignal,

  // TDFI (Trend Direction & Force Index)
  calculateTDFISeries,
  getTDFISignal,

  // DSS-MOM (DSS Averages of Momentum)
  calculateDSSMOMSeries,
  getDSSMOMSignal,
} from 'trading-bot-platform';
```

### Strategy

```typescript
import {
  generateSignal,
  isValidSignal,
  createTwoLegPosition,
  updatePositions,
  getOpenLegs,
  getClosedLegs,
} from 'trading-bot-platform';

// Generate signal from MFI crossover
const signal = generateSignal(prevMFI, currMFI, price, atr, timestamp, buyLevel, sellLevel);

// Create two-leg position
const legs = createTwoLegPosition(signal, atrTpMultiplier, atrTrailMultiplier);

// Update positions with current price
const updatedLegs = updatePositions(legs, currentPrice, atr, trailMult, breakEvenMult);
```

### Brokers

```typescript
import { PaperBroker, LiveBroker } from 'trading-bot-platform';

// Paper trading (simulation)
const paperBroker = new PaperBroker({
  initialUsdcBalance: 10000,
  slippageBps: 50,
  tradeLegUsdc: 100,
});

// Live trading (real money!)
const liveBroker = new LiveBroker({
  rpcUrl: 'https://...',
  walletSecretKey: '...',
  usdcMint: '...',
  slippageBps: 50,
  tradeLegUsdc: 100,
  // ... other config
});

// Both have same interface
const legs = await broker.openPosition(signal, candle);
const updated = await broker.trimRunners(legs, signal, candle);
```

### Multi-Asset Trading

```typescript
import {
  initializeMultiAssetState,
  getAssetPositions,
  updateAssetPositions,
  canAssetTrade,
  recordAssetTrade,
  getMultiAssetSummary,
  getEnabledAssets,
} from 'trading-bot-platform';

// Initialize state
const assets = [
  { symbol: 'wETH', enabled: true, tradeLegUsdc: 100, ... },
  { symbol: 'SOL', enabled: true, tradeLegUsdc: 100, ... },
];
const state = initializeMultiAssetState(assets);

// Check if asset can trade
const managerConfig = {
  assets,
  maxPositionsPerAsset: 1,
  maxTotalPositions: 6,
  minTimeBetweenTradesMs: 4 * 60 * 60 * 1000,
};
const { canTrade, reason } = canAssetTrade(state, 'wETH', managerConfig, Date.now());
```

### Data Fetching

```typescript
import { BinanceFetcher } from 'trading-bot-platform';

const fetcher = new BinanceFetcher({
  symbol: 'ETHUSDT',
  interval: '4h',  // '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | ...
});

const candles = await fetcher.fetchCandles(100);
// Returns: Array<{ timestamp, open, high, low, close, volume }>
```

### Dashboard (Optional)

```typescript
import { createDashboardApp } from 'trading-bot-platform/dashboard';

const dashboard = createDashboardApp({
  port: 3001,
  botsFile: './bots.json',
  stateDir: './',
  logsDir: './logs',
  csvDir: './logs/csv',
  jwtSecret: 'your-secret',
  adminUsername: 'admin',
  adminPasswordHash: '...',
  corsOrigins: ['http://localhost:5173'],
  servicePrefix: 'bot@',
});

await dashboard.start();
```

### Utils

```typescript
import {
  loadEnvConfig,
  getRequiredEnv,
  getOptionalEnv,
  getNumericEnv,
  getBooleanEnv,
  createTradingCSVLogger,
} from 'trading-bot-platform';

// Load environment
loadEnvConfig('.env', '.env.local');

const rpcUrl = getRequiredEnv('SOLANA_RPC_URL');
const paperMode = getBooleanEnv('PAPER_MODE', true);
const slippage = getNumericEnv('SLIPPAGE_BPS', 50);

// CSV logging
const csvLogger = createTradingCSVLogger({ csvDir: 'logs/csv' });
csvLogger.logTradeEntry({ ... });
csvLogger.logPositionLegClosure(leg, asset, mode);
```

## Types

Key types exported:

```typescript
import type {
  // Candles
  Candle,

  // Signals
  Signal,
  SignalType,

  // Positions
  PositionLeg,
  LegType,
  LegStatus,

  // Bot state
  BotState,
  MultiAssetBotState,
  AssetPositions,

  // Assets
  AssetConfig,
  AssetSignal,

  // Config
  MultiAssetManagerConfig,
  LoggerConfig,
  PaperBrokerConfig,
  LiveBrokerConfig,
} from 'trading-bot-platform';
```

## Peer Dependencies

These must be installed in your project:

```json
{
  "@jup-ag/api": "^6.0.0",
  "@solana/spl-token": "^0.4.0",
  "@solana/web3.js": "^1.95.0"
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
