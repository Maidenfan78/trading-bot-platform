/**
 * Dashboard API Types
 */

// ===== Bot Configuration =====

export interface BotConfig {
  id: string;
  name: string;
  stateFile: string;
  logFile: string;
  serviceName: string;
  csvDir: string;
  indicator?: string;
  timeframe?: string;
}

// ===== Bot State Types =====

export interface PositionLeg {
  id: string;
  type: 'TP' | 'RUNNER';
  entryPrice: number;
  quantity: number;
  entryTime: number;
  targetPrice?: number;
  trailingStop?: number;
  highestPrice?: number;
  status: 'OPEN' | 'CLOSED';
  closePrice?: number;
  closeTime?: number;
  closeReason?: string;
  pnlUsdc?: number;
  pnlPercent?: number;
  asset?: string;
}

export interface BotState {
  lastProcessedCandleTime: number;
  lastTradeTime: number;
  openLegs: PositionLeg[];
  totalTradesToday: number;
  lastDayReset: string;
}

export interface AssetPositions {
  asset: string;
  openLegs: PositionLeg[];
  lastSignalTime: number;
  lastTradeTime: number;
}

export interface MultiAssetBotState {
  lastProcessedCandleTime: number;
  lastDayReset: string;
  assetPositions: AssetPositions[];
}

export interface CircuitBreakerState {
  tripped: boolean;
  reason?: string;
  tripTime?: number;
  dailyLossPct?: number;
  consecutiveLosses?: number;
  tradesToday?: number;
}

// ===== API Response Types =====

export interface BotStatusResponse {
  id: string;
  name: string;
  running: boolean;
  pid: number | null;
  uptime: number;
  lastUpdate: string;
  state: BotState | MultiAssetBotState | Record<string, unknown>;
  circuitBreaker: CircuitBreakerState;
}

export type StatusResponse = Record<string, BotStatusResponse>;

export interface PositionsResponse {
  bot: string;
  positions: PositionLeg[];
  totalValue: number;
  totalPnL: number;
  totalPnLPct: number;
}

export interface TradeEntry {
  date: string;
  timestamp: number;
  action: string;
  price: number;
  signalType: string;
  mfi: number;
  usdcAmount: number;
  btcAmount: number;
  slippage?: number;
  asset?: string;
}

export interface TradesResponse {
  bot: string;
  trades: TradeEntry[];
  total: number;
  hasMore: boolean;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalPnL: number;
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
}

export interface PerformanceResponse {
  bot: string;
  metrics: PerformanceMetrics;
  equityCurve: EquityPoint[];
  byAsset?: { [asset: string]: PerformanceMetrics };
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface LogsResponse {
  bot: string;
  logs: LogEntry[];
  hasMore: boolean;
}

export interface ControlResponse {
  success: boolean;
  message: string;
  action?: string;
}

// ===== WebSocket Event Types =====

export interface WebSocketMessage {
  type: string;
  bot?: string;
  data?: unknown;
  timestamp: string;
}

export interface StateUpdateEvent extends WebSocketMessage {
  type: 'state_update';
  bot: string;
  data: BotState | MultiAssetBotState;
}

export interface LogEntryEvent extends WebSocketMessage {
  type: 'log_entry';
  bot: string;
  data: LogEntry;
}

// ===== Dashboard Configuration =====

export interface DashboardConfig {
  port: number;
  botsFile: string;
  stateDir: string;
  logsDir: string;
  csvDir: string;
  jwtSecret: string;
  adminUsername: string;
  adminPasswordHash: string;
  corsOrigins: string[];
  servicePrefix?: string;
  dataDir?: string;
  projectRoot?: string;
}

// ===== Journal Types =====

export interface TradeTag {
  id: string;
  name: string;
  color: string;
}

export interface JournalEntry {
  tradeId: string;
  botId: string;
  asset: string;
  entryDate: string;
  exitDate?: string;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnlUsdc?: number;
  pnlPercent?: number;
  legType: 'TP' | 'RUNNER';
  exitReason?: string;
  holdingPeriod?: string;
  mode: 'PAPER' | 'LIVE';
  notes: string;
  tags: string[];
  rating?: number;
  lessonLearned?: string;
  screenshots?: string[];
  createdAt: number;
  updatedAt: number;
}

// ===== Service Types =====

export interface ServiceStatus {
  running: boolean;
  pid: number | null;
  uptime: number;
  activeState: string;
}

// ===== Indicator Options =====

export interface IndicatorOption {
  id: string;
  label: string;
  timeframes: string[];
}

export const INDICATORS: IndicatorOption[] = [
  { id: 'mfi', label: 'MFI', timeframes: ['1h', '4h', '1d'] },
  { id: 'tcf2', label: 'TCF2', timeframes: ['1h', '4h', '1d'] },
  { id: 'kpss', label: 'KPSS', timeframes: ['1h', '4h', '1d'] },
  { id: 'tdfi', label: 'TDFI', timeframes: ['1h', '4h', '1d'] },
  { id: 'dssmom', label: 'DSS-MOM', timeframes: ['1h', '4h', '1d'] },
];

export const TIMEFRAMES = ['1h', '4h', '1d'];
