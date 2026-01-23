/**
 * Dashboard App Factory
 *
 * Creates a configured Express + Socket.IO dashboard application.
 */

import express, { Application, Router, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { readFileSync, existsSync, writeFileSync, promises as fs, mkdirSync } from 'fs';

import {
  DashboardConfig,
  BotConfig,
  BotState,
  MultiAssetBotState,
  INDICATORS,
  TIMEFRAMES,
} from './types';

import {
  StateWatcher,
  SystemctlService,
  CSVReader,
  LogTailer,
  JournalDbService,
  getCurrentPrices,
  normalizeAssetName,
} from './services';

import {
  EventStore,
  JournalEventType,
  JournalEventCategory,
} from '../journal/index.js';

import {
  createVerifyToken,
  createLogin,
  rateLimitLogin,
  resetRateLimit,
  createErrorHandler,
  notFoundHandler,
  asyncHandler,
} from './middleware';

export interface DashboardApp {
  app: Application;
  httpServer: HttpServer;
  io: SocketIOServer;
  stateWatcher: StateWatcher;
  systemctl: SystemctlService;
  csvReader: CSVReader;
  logTailer: LogTailer;
  journalDb: JournalDbService;
  eventStore: EventStore;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Create a dashboard application
 */
export function createDashboardApp(config: DashboardConfig): DashboardApp {
  // Validate config
  if (!config.jwtSecret || config.jwtSecret.includes('your-secret')) {
    throw new Error('SECURITY: Please provide a proper JWT_SECRET!');
  }
  if (!config.adminPasswordHash) {
    throw new Error('Configuration: adminPasswordHash is required');
  }

  // Initialize Express app
  const app = express();
  const httpServer = createServer(app);

  // Initialize Socket.IO
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Middleware
  app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
  }));
  app.use(express.json());

  // Initialize services
  const stateWatcher = new StateWatcher();
  const systemctl = new SystemctlService();
  const logTailer = new LogTailer();

  const dataDir = config.dataDir || path.join(config.stateDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const journalDb = new JournalDbService(dataDir);
  const eventStore = new EventStore({ dataDir });

  // Bot configuration helpers
  const legacyBotIdMap: Record<string, string> = {
    btc: 'btc-daily',
    '4h': '4h-mfi',
  };

  function loadBots(): BotConfig[] {
    if (existsSync(config.botsFile)) {
      try {
        const data = readFileSync(config.botsFile, 'utf-8');
        return JSON.parse(data);
      } catch (error) {
        console.error('Failed to load bots.json:', error);
      }
    }
    return [];
  }

  function saveBots(bots: BotConfig[]): void {
    writeFileSync(config.botsFile, JSON.stringify(bots, null, 2), 'utf-8');
  }

  function getBotConfig(botId: string): BotConfig | undefined {
    const normalizedId = legacyBotIdMap[botId] ?? botId;
    const bots = loadBots();
    return bots.find(b => b.id === normalizedId);
  }

  function isValidBotId(botId: string): boolean {
    return Boolean(getBotConfig(botId));
  }

  // Create CSV reader with bot config lookup
  const csvReader = new CSVReader(config.csvDir, undefined, getBotConfig);

  // Auth middleware and login function
  const verifyToken = createVerifyToken(config.jwtSecret);
  const login = createLogin(config.jwtSecret, config.adminUsername, config.adminPasswordHash);

  // Setup state watchers for all bots from bots.json
  const allBots = loadBots();
  for (const bot of allBots) {
    stateWatcher.watchBotState(bot.id, bot.stateFile);
  }

  // Broadcast state changes via WebSocket
  stateWatcher.onStateChange((botName, state) => {
    io.emit('state_update', {
      type: 'state_update',
      bot: botName,
      data: state,
      timestamp: new Date().toISOString(),
    });
  });

  // Start tailing log files for all bots and broadcast new entries
  for (const bot of allBots) {
    logTailer.startTailing(bot.logFile, (entry) => {
      io.emit('log_entry', {
        type: 'log_entry',
        bot: bot.id,
        data: entry,
        timestamp: new Date().toISOString(),
      });
    });
  }

  // WebSocket connection handling
  io.on('connection', (socket) => {
    console.log(`WebSocket client connected: ${socket.id}`);

    socket.on('subscribe', (data: { bots: string[] }) => {
      console.log(`Client ${socket.id} subscribed to:`, data.bots);
      // Send initial state
      for (const bot of data.bots) {
        const state = stateWatcher.getCurrentState(bot);
        if (state) {
          socket.emit('state_update', {
            type: 'state_update',
            bot,
            data: state,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    socket.on('ping', () => {
      socket.emit('pong', {
        type: 'pong',
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('disconnect', () => {
      console.log(`WebSocket client disconnected: ${socket.id}`);
    });
  });

  // ========== Routes ==========

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // ========== Auth Routes ==========
  const authRouter = Router();

  authRouter.post('/login', rateLimitLogin, asyncHandler(async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const token = await login(username, password);

    if (!token) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    resetRateLimit(req);

    res.json({
      token,
      expiresIn: '24h',
      tokenType: 'Bearer',
    });
  }));

  app.use('/api/auth', authRouter);

  // ========== Bots Routes ==========
  const botsRouter = Router();
  const projectRoot = config.projectRoot || config.stateDir;

  botsRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const bots = loadBots();
    res.json({
      bots: bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        serviceName: bot.serviceName,
        indicator: bot.indicator,
        timeframe: bot.timeframe,
      })),
    });
  }));

  botsRouter.get('/options', asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      indicators: INDICATORS,
      timeframes: TIMEFRAMES,
    });
  }));

  botsRouter.post('/', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const { indicator, timeframe, name, botId } = req.body;

    if (!indicator || !timeframe) {
      return res.status(400).json({ success: false, error: 'indicator and timeframe are required' });
    }

    const normalizedIndicator = indicator.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTimeframe = timeframe.trim().toLowerCase() === 'd1' ? '1d' : timeframe.trim().toLowerCase();

    const indicatorConfig = INDICATORS.find((item) => item.id === normalizedIndicator);
    if (!indicatorConfig) {
      return res.status(400).json({ success: false, error: 'Unsupported indicator' });
    }

    if (!TIMEFRAMES.includes(normalizedTimeframe)) {
      return res.status(400).json({ success: false, error: 'Unsupported timeframe' });
    }

    const bots = loadBots();
    const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const randomSuffix = () => Math.random().toString(36).slice(2, 6);

    let finalBotId = botId ? slugify(botId) : name ? slugify(name) : `${normalizedIndicator}-${normalizedTimeframe}`;
    while (bots.find(b => b.id === finalBotId)) {
      finalBotId = `${finalBotId}-${randomSuffix()}`;
    }

    const botName = name?.trim() || `${indicatorConfig.label} ${normalizedTimeframe.toUpperCase()}`;

    const newBot: BotConfig = {
      id: finalBotId,
      name: botName,
      stateFile: path.join(projectRoot, `state-${finalBotId}.json`),
      logFile: path.join(projectRoot, 'logs', `bot-${finalBotId}.log`),
      serviceName: `bot@${finalBotId}`,
      csvDir: finalBotId,
      indicator: normalizedIndicator,
      timeframe: normalizedTimeframe,
    };

    bots.push(newBot);
    saveBots(bots);

    // Start watching the new bot
    stateWatcher.watchBotState(newBot.id, newBot.stateFile);

    try {
      await systemctl.enable(newBot.serviceName);
      await systemctl.start(newBot.serviceName);
    } catch (error) {
      console.error('Failed to start bot service:', error);
    }

    res.json({ success: true, bot: newBot });
  }));

  botsRouter.delete('/:botId', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const botId = req.params.botId as string;
    const bots = loadBots();
    const botIndex = bots.findIndex((bot) => bot.id === botId);
    if (botIndex === -1) {
      return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const bot = bots[botIndex];
    bots.splice(botIndex, 1);
    saveBots(bots);

    // Stop watching the bot
    stateWatcher.unwatchBot(botId);

    try {
      await systemctl.stop(bot.serviceName);
      await systemctl.disable(bot.serviceName);
    } catch (error) {
      console.error('Failed to stop bot service:', error);
    }

    // Clean up files
    await fs.rm(bot.stateFile, { force: true }).catch(() => {});
    await fs.rm(bot.logFile, { force: true }).catch(() => {});
    await fs.rm(path.join(config.csvDir, bot.csvDir), { force: true, recursive: true }).catch(() => {});

    res.json({ success: true, botId });
  }));

  app.use('/api/bots', botsRouter);

  // ========== Status Route ==========
  app.get('/api/status', asyncHandler(async (_req, res) => {
    const bots = loadBots();
    const result: Record<string, unknown> = {};

    const statusPromises = bots.map(bot =>
      systemctl.getStatus(bot.serviceName).then(status => ({ bot, status }))
    );
    const statuses = await Promise.all(statusPromises);

    for (const { bot, status } of statuses) {
      const botState = stateWatcher.getCurrentState(bot.id);

      let openPositionCount = 0;
      if (botState && 'assetPositions' in botState && botState.assetPositions) {
        openPositionCount = (botState as MultiAssetBotState).assetPositions.reduce((count, ap) => {
          const openLegs = (ap.openLegs || []).filter((leg) => leg.status === 'OPEN' || !leg.status);
          return count + openLegs.length;
        }, 0);
      } else if (botState && 'openLegs' in botState) {
        openPositionCount = ((botState as BotState).openLegs || []).length;
      }

      const botCsvReader = new CSVReader(config.csvDir, bot.csvDir, getBotConfig);
      let metrics = { totalTrades: 0, totalPnL: 0, winRate: 0 };
      let lastTradeTime = 0;

      try {
        const positions = botCsvReader.readPositions();
        metrics = botCsvReader.calculateMetrics(positions);
        lastTradeTime = positions.reduce((latest, pos) => {
          const candidate = pos.closeTime || pos.entryTime || 0;
          return candidate > latest ? candidate : latest;
        }, 0);
      } catch (e) {
        // CSV files may not exist yet for new bots
      }

      if (botState && 'lastTradeTime' in botState && typeof botState.lastTradeTime === 'number') {
        lastTradeTime = Math.max(lastTradeTime, botState.lastTradeTime);
      } else if (botState && 'assetPositions' in botState && botState.assetPositions) {
        const assetTradeTimes = (botState as MultiAssetBotState).assetPositions.map((ap) => ap.lastTradeTime || 0);
        const maxAssetTrade = assetTradeTimes.length > 0 ? Math.max(...assetTradeTimes) : 0;
        lastTradeTime = Math.max(lastTradeTime, maxAssetTrade);
      }

      result[bot.id] = {
        id: bot.id,
        name: bot.name,
        running: status.running,
        pid: status.pid,
        uptime: status.uptime,
        lastUpdate: new Date().toISOString(),
        state: botState ? {
          ...botState,
          openPositionCount,
          lastTradeTime,
          performance: {
            totalTrades: metrics.totalTrades,
            totalPnL: metrics.totalPnL,
            winRate: metrics.winRate,
          },
          lastUpdate: new Date().toISOString(),
        } : {},
        circuitBreaker: { tripped: false },
      };
    }

    res.json(result);
  }));

  // ========== Positions Route ==========
  app.get('/api/positions/:bot', asyncHandler(async (req, res) => {
    const bot = req.params.bot as string;

    if (!isValidBotId(bot)) {
      const validBots = loadBots().map(b => b.id).join(', ');
      return res.status(400).json({ error: `Invalid bot name. Valid bots: ${validBots}` });
    }

    const state = stateWatcher.getCurrentState(bot);
    if (!state) {
      return res.status(404).json({ error: 'Bot state not found' });
    }

    const prices = await getCurrentPrices();
    let positions: Array<Record<string, unknown>> = [];
    let totalValue = 0;
    let totalPnL = 0;

    if ('openLegs' in state) {
      const currentPrice = prices['BTC'];
      positions = (state as BotState).openLegs.map((leg) => {
        const unrealizedPnL = currentPrice ? (currentPrice - leg.entryPrice) * leg.quantity : undefined;
        const unrealizedPnLPercent = currentPrice ? ((currentPrice - leg.entryPrice) / leg.entryPrice) * 100 : undefined;

        if (currentPrice) {
          totalValue += currentPrice * leg.quantity;
          if (unrealizedPnL !== undefined) totalPnL += unrealizedPnL;
        }

        return {
          ...leg,
          symbol: 'BTC',
          side: 'LONG',
          openedAt: leg.entryTime,
          currentPrice,
          unrealizedPnL,
          unrealizedPnLPercent,
          target: leg.targetPrice || leg.highestPrice,
        };
      });
    } else if ('assetPositions' in state) {
      positions = (state as MultiAssetBotState).assetPositions.flatMap((ap) => {
        const normalizedAsset = normalizeAssetName(ap.asset);
        const currentPrice = prices[normalizedAsset];
        const openLegs = ap.openLegs.filter((leg) => leg.status === 'OPEN' || !leg.status);
        return openLegs.map((leg) => {
          const unrealizedPnL = currentPrice ? (currentPrice - leg.entryPrice) * leg.quantity : undefined;
          const unrealizedPnLPercent = currentPrice ? ((currentPrice - leg.entryPrice) / leg.entryPrice) * 100 : undefined;

          if (currentPrice) {
            totalValue += currentPrice * leg.quantity;
            if (unrealizedPnL !== undefined) totalPnL += unrealizedPnL;
          }

          return {
            ...leg,
            symbol: ap.asset,
            side: 'LONG',
            openedAt: leg.entryTime,
            currentPrice,
            unrealizedPnL,
            unrealizedPnLPercent,
            target: leg.targetPrice || leg.highestPrice,
          };
        });
      });
    }

    const totalPnLPct = totalValue > 0 ? (totalPnL / (totalValue - totalPnL)) * 100 : 0;

    res.json({ bot, positions, totalValue, totalPnL, totalPnLPct });
  }));

  // ========== Trades Route ==========
  app.get('/api/trades/:bot', asyncHandler(async (req, res) => {
    const bot = req.params.bot as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const botConfig = getBotConfig(bot);
    if (!botConfig) {
      const validBots = loadBots().map(b => b.id).join(', ');
      return res.status(400).json({ error: `Invalid bot name. Valid bots: ${validBots}` });
    }

    const botCsvReader = new CSVReader(config.csvDir, botConfig.csvDir, getBotConfig);
    const trades = botCsvReader.readTrades(limit + 1, offset);
    const hasMore = trades.length > limit;
    const result = trades.slice(0, limit);

    res.json({ bot, trades: result, total: result.length, hasMore });
  }));

  // ========== Performance Route ==========
  app.get('/api/performance/:bot', asyncHandler(async (req, res) => {
    const bot = req.params.bot as string;

    const botConfig = getBotConfig(bot);
    if (!botConfig) {
      const validBots = loadBots().map(b => b.id).join(', ');
      return res.status(400).json({ error: `Invalid bot name. Valid bots: ${validBots}` });
    }

    const botCsvReader = new CSVReader(config.csvDir, botConfig.csvDir, getBotConfig);
    const positions = botCsvReader.readPositions();
    const metrics = botCsvReader.calculateMetrics(positions);
    const equityCurve = botCsvReader.readEquityCurve();

    res.json({
      bot,
      metrics: {
        ...metrics,
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
      },
      equityCurve,
    });
  }));

  // ========== Control Routes ==========
  const controlRouter = Router();

  controlRouter.post('/:bot/:action', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const bot = req.params.bot as string;
    const action = req.params.action as string;
    const { confirm } = req.body;

    const botConfig = getBotConfig(bot);
    if (!botConfig) {
      const validBots = loadBots().map(b => b.id).join(', ');
      return res.status(400).json({ success: false, error: `Invalid bot name. Valid bots: ${validBots}` });
    }

    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid action. Must be "start", "stop", or "restart"' });
    }

    if (!confirm) {
      return res.status(400).json({ success: false, error: 'Confirmation required. Send { "confirm": true } in request body.' });
    }

    const serviceName = botConfig.serviceName;
    console.log(`User ${req.user?.username} requested ${action} for ${bot} bot (${serviceName})`);

    const exists = await systemctl.serviceExists(serviceName);
    if (!exists) {
      return res.status(404).json({ success: false, error: `Service ${serviceName} not found` });
    }

    switch (action) {
      case 'start':
        await systemctl.start(serviceName);
        break;
      case 'stop':
        await systemctl.stop(serviceName);
        break;
      case 'restart':
        await systemctl.restart(serviceName);
        break;
    }

    const status = await systemctl.getStatus(serviceName);

    res.json({
      success: true,
      message: `Bot ${bot} ${action} completed successfully`,
      action,
      bot,
      serviceName,
      status: { running: status.running, pid: status.pid },
    });
  }));

  app.use('/api/control', controlRouter);

  // ========== Logs Routes ==========
  const logsRouter = Router();

  logsRouter.get('/:bot', asyncHandler(async (req: Request, res: Response) => {
    const bot = req.params.bot as string;
    const lines = parseInt(req.query.lines as string) || 100;
    const level = (req.query.level as string) || 'all';
    const search = req.query.search as string | undefined;

    const botConfig = getBotConfig(bot);
    if (!botConfig) {
      const validBots = loadBots().map(b => b.id).join(', ');
      return res.status(400).json({ error: `Invalid bot name. Valid bots: ${validBots}` });
    }

    if (lines < 1 || lines > 1000) {
      return res.status(400).json({ error: 'Lines must be between 1 and 1000' });
    }

    let logs = logTailer.readLastLines(botConfig.logFile, lines);

    if (level !== 'all') {
      logs = logTailer.filterByLevel(logs, level);
    }

    if (search) {
      logs = logTailer.searchLogs(logs, search);
    }

    res.json({
      bot,
      logs,
      total: logs.length,
      hasMore: logs.length >= lines,
      filters: {
        level: level !== 'all' ? level : undefined,
        search: search || undefined,
        lines,
      },
    });
  }));

  app.use('/api/logs', logsRouter);

  // ========== Journal Routes ==========
  const journalRouter = Router();

  journalRouter.get('/bots', verifyToken, asyncHandler(async (_req: Request, res: Response) => {
    const bots = loadBots();
    res.json({ success: true, bots: bots.map(b => ({ id: b.id, name: b.name })) });
  }));

  journalRouter.get('/entries', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const { botId, asset, startDate, endDate, tag } = req.query;

    let entries = journalDb.getAllEntries(botId as string | undefined);

    if (asset && typeof asset === 'string') {
      entries = entries.filter(e => e.asset === asset);
    }

    if (startDate && endDate) {
      const start = new Date(startDate as string).getTime();
      const end = new Date(endDate as string).getTime();
      entries = entries.filter(e => {
        const entryTime = new Date(e.entryDate).getTime();
        return entryTime >= start && entryTime <= end;
      });
    }

    if (tag && typeof tag === 'string') {
      entries = entries.filter(e => e.tags.includes(tag));
    }

    res.json({ success: true, entries, total: entries.length });
  }));

  journalRouter.get('/entries/:tradeId', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const tradeId = req.params.tradeId as string;
    const entry = journalDb.getEntryByTradeId(tradeId);

    if (!entry) {
      return res.status(404).json({ success: false, error: 'Entry not found' });
    }

    res.json({ success: true, entry });
  }));

  journalRouter.post('/entries', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const entry = req.body;

    if (!entry.tradeId) {
      return res.status(400).json({ success: false, error: 'tradeId is required' });
    }

    const result = journalDb.upsertEntry(entry);
    res.json({ success: true, entry: result });
  }));

  journalRouter.get('/tags', verifyToken, asyncHandler(async (_req: Request, res: Response) => {
    const tags = journalDb.getAllTags();
    res.json({ success: true, tags });
  }));

  journalRouter.post('/tags', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const { name, color } = req.body;

    if (!name || !color) {
      return res.status(400).json({ success: false, error: 'name and color are required' });
    }

    const tag = journalDb.createTag(name, color);
    res.json({ success: true, tag });
  }));

  journalRouter.get('/statistics', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const { botId } = req.query;
    const stats = journalDb.getStatistics(botId as string | undefined);
    res.json({ success: true, statistics: stats });
  }));

  journalRouter.post('/sync/:botId', verifyToken, asyncHandler(async (req: Request, res: Response) => {
    const botId = req.params.botId as string;

    if (!isValidBotId(botId)) {
      return res.status(400).json({ success: false, error: `Invalid botId: ${botId}` });
    }

    const positions = csvReader.readPositionsForBot(botId);

    const trades = positions
      .filter(p => p.status === 'CLOSED')
      .map(p => ({
        tradeId: p.id,
        asset: p.asset || 'BTC',
        entryDate: new Date(p.entryTime).toISOString(),
        exitDate: p.closeTime ? new Date(p.closeTime).toISOString() : undefined,
        entryPrice: p.entryPrice,
        exitPrice: p.closePrice,
        quantity: p.quantity,
        pnlUsdc: p.pnlUsdc,
        pnlPercent: p.pnlPercent,
        legType: p.type,
        exitReason: p.closeReason,
        holdingPeriod: undefined,
        mode: 'PAPER' as const,
      }));

    const imported = journalDb.importFromCsv(botId, trades);

    res.json({ success: true, message: `Synced ${imported} new trades to journal`, imported, total: trades.length, botId });
  }));

  app.use('/api/journal', journalRouter);

  // ========== Timeline Routes ==========
  const timelineRouter = Router();

  // Get timeline feed (paginated)
  timelineRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
    const {
      botId,
      asset,
      types,
      category,
      startTime,
      endTime,
      cycleId,
      positionId,
      limit,
      offset,
    } = req.query;

    const result = eventStore.query({
      botId: botId as string | undefined,
      asset: asset as string | undefined,
      types: types ? (types as string).split(',') as JournalEventType[] : undefined,
      category: category as JournalEventCategory | undefined,
      startTime: startTime ? parseInt(startTime as string) : undefined,
      endTime: endTime ? parseInt(endTime as string) : undefined,
      cycleId: cycleId as string | undefined,
      positionId: positionId as string | undefined,
      limit: parseInt(limit as string) || 50,
      offset: parseInt(offset as string) || 0,
    });

    res.json({
      success: true,
      events: result.events,
      total: result.total,
      hasMore: result.hasMore,
    });
  }));

  // Get all events for a specific cycle
  timelineRouter.get('/cycle/:cycleId', asyncHandler(async (req: Request, res: Response) => {
    const cycleId = req.params.cycleId as string;
    const events = eventStore.getCycleEvents(cycleId);
    res.json({ success: true, events, total: events.length });
  }));

  // Get all events for a specific position
  timelineRouter.get('/position/:positionId', asyncHandler(async (req: Request, res: Response) => {
    const positionId = req.params.positionId as string;
    const events = eventStore.getPositionEvents(positionId);
    res.json({ success: true, events, total: events.length });
  }));

  // Get filter options for UI dropdowns
  timelineRouter.get('/filters', asyncHandler(async (_req: Request, res: Response) => {
    const options = eventStore.getFilterOptions();
    res.json({
      success: true,
      filters: {
        botIds: options.botIds,
        assets: options.assets,
        categories: options.categories,
        types: options.types,
      },
    });
  }));

  // Get recent events (for real-time dashboard)
  timelineRouter.get('/recent', asyncHandler(async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const events = eventStore.recent(limit);
    res.json({ success: true, events, total: events.length });
  }));

  // Archive old events (admin)
  timelineRouter.post('/archive', verifyToken, asyncHandler(async (_req: Request, res: Response) => {
    const result = eventStore.archive();
    res.json({
      success: true,
      message: `Archived ${result.archivedCount} events`,
      archivedCount: result.archivedCount,
      archivedTo: result.archivedTo,
    });
  }));

  app.use('/api/timeline', timelineRouter);

  // Error handling middleware (must be last)
  app.use(notFoundHandler);
  app.use(createErrorHandler(process.env.NODE_ENV === 'development'));

  // Start and stop functions
  async function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(config.port, () => {
        console.log('========================================');
        console.log(`Trading Bot Dashboard API`);
        console.log(`Server: http://localhost:${config.port}`);
        console.log(`WebSocket: ws://localhost:${config.port}`);
        console.log(`CORS Origins: ${config.corsOrigins.join(', ')}`);
        console.log('========================================');
        console.log('Watching bot state files...');
        for (const bot of loadBots()) {
          console.log(`  ${bot.id}: ${bot.stateFile}`);
        }
        console.log('========================================');
        console.log('API is ready!');
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    return new Promise((resolve) => {
      stateWatcher.close();
      logTailer.closeAll();
      httpServer.close(() => {
        console.log('Server closed');
        resolve();
      });
    });
  }

  // Graceful shutdown handlers
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('\nSIGINT received, shutting down gracefully...');
    await stop();
    process.exit(0);
  });

  return {
    app,
    httpServer,
    io,
    stateWatcher,
    systemctl,
    csvReader,
    logTailer,
    journalDb,
    eventStore,
    start,
    stop,
  };
}
