/**
 * Trade Journal Database Service
 * Uses JSON file for persistent storage of trade notes, tags, and metadata
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { JournalEntry, TradeTag } from '../types';

interface JournalDatabase {
  entries: JournalEntry[];
  tags: TradeTag[];
  version: number;
}

// Default tags
const DEFAULT_TAGS: TradeTag[] = [
  { id: 'mfi-signal', name: 'MFI Signal', color: '#4CAF50' },
  { id: 'trend-follow', name: 'Trend Follow', color: '#2196F3' },
  { id: 'breakout', name: 'Breakout', color: '#FF9800' },
  { id: 'reversal', name: 'Reversal', color: '#9C27B0' },
  { id: 'tp-hit', name: 'TP Hit', color: '#00BCD4' },
  { id: 'stopped-out', name: 'Stopped Out', color: '#F44336' },
  { id: 'manual-close', name: 'Manual Close', color: '#607D8B' },
  { id: 'learning', name: 'Learning', color: '#FFEB3B' },
];

/**
 * Journal Database Service
 */
export class JournalDbService {
  private db: JournalDatabase;
  private dbFile: string;

  constructor(dataDir: string) {
    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.dbFile = join(dataDir, 'journal.json');
    this.db = this.loadDatabase();
  }

  /**
   * Load database from file or create new one
   */
  private loadDatabase(): JournalDatabase {
    // Load existing database or create new one
    if (existsSync(this.dbFile)) {
      try {
        const data = readFileSync(this.dbFile, 'utf-8');
        const db = JSON.parse(data) as JournalDatabase;

        // Migration: Add botId to entries that don't have it
        let migrated = false;
        for (const entry of db.entries) {
          if (!entry.botId) {
            entry.botId = 'unknown';
            migrated = true;
          }
        }

        if (migrated) {
          console.log('Migrated journal entries to include botId');
          writeFileSync(this.dbFile, JSON.stringify(db, null, 2), 'utf-8');
        }

        return db;
      } catch (error) {
        console.error('Failed to load journal database, creating new one:', error);
      }
    }

    // Create new database
    const newDb: JournalDatabase = {
      entries: [],
      tags: DEFAULT_TAGS,
      version: 1,
    };
    this.saveDatabase(newDb);
    return newDb;
  }

  /**
   * Save database to file
   */
  private saveDatabase(db?: JournalDatabase): void {
    const data = db || this.db;
    writeFileSync(this.dbFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ============ Journal Entries ============

  /**
   * Get all journal entries, optionally filtered by botId
   */
  getAllEntries(botId?: string): JournalEntry[] {
    let entries = this.db.entries;
    if (botId) {
      entries = entries.filter(e => e.botId === botId);
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get entries by bot ID
   */
  getEntriesByBot(botId: string): JournalEntry[] {
    return this.db.entries.filter(e => e.botId === botId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get entry by trade ID
   */
  getEntryByTradeId(tradeId: string): JournalEntry | undefined {
    return this.db.entries.find(e => e.tradeId === tradeId);
  }

  /**
   * Get entries by asset
   */
  getEntriesByAsset(asset: string): JournalEntry[] {
    return this.db.entries.filter(e => e.asset === asset);
  }

  /**
   * Get entries by date range
   */
  getEntriesByDateRange(startDate: number, endDate: number): JournalEntry[] {
    return this.db.entries.filter(e => {
      const entryTime = new Date(e.entryDate).getTime();
      return entryTime >= startDate && entryTime <= endDate;
    });
  }

  /**
   * Create or update journal entry
   */
  upsertEntry(entry: Partial<JournalEntry> & { tradeId: string; botId?: string }): JournalEntry {
    const existing = this.getEntryByTradeId(entry.tradeId);
    const now = Date.now();

    if (existing) {
      // Update existing entry
      const updated: JournalEntry = {
        ...existing,
        ...entry,
        updatedAt: now,
      };
      const index = this.db.entries.findIndex(e => e.tradeId === entry.tradeId);
      this.db.entries[index] = updated;
      this.saveDatabase();
      return updated;
    } else {
      // Create new entry
      const newEntry: JournalEntry = {
        tradeId: entry.tradeId,
        botId: entry.botId || 'unknown',
        asset: entry.asset || 'UNKNOWN',
        entryDate: entry.entryDate || new Date().toISOString(),
        exitDate: entry.exitDate,
        entryPrice: entry.entryPrice || 0,
        exitPrice: entry.exitPrice,
        quantity: entry.quantity || 0,
        pnlUsdc: entry.pnlUsdc,
        pnlPercent: entry.pnlPercent,
        legType: entry.legType || 'TP',
        exitReason: entry.exitReason,
        holdingPeriod: entry.holdingPeriod,
        mode: entry.mode || 'PAPER',
        notes: entry.notes || '',
        tags: entry.tags || [],
        rating: entry.rating,
        lessonLearned: entry.lessonLearned,
        screenshots: entry.screenshots || [],
        createdAt: now,
        updatedAt: now,
      };
      this.db.entries.push(newEntry);
      this.saveDatabase();
      return newEntry;
    }
  }

  /**
   * Update notes for a trade
   */
  updateNotes(tradeId: string, notes: string): JournalEntry | null {
    const entry = this.getEntryByTradeId(tradeId);
    if (!entry) return null;

    entry.notes = notes;
    entry.updatedAt = Date.now();
    this.saveDatabase();
    return entry;
  }

  /**
   * Update tags for a trade
   */
  updateTags(tradeId: string, tags: string[]): JournalEntry | null {
    const entry = this.getEntryByTradeId(tradeId);
    if (!entry) return null;

    entry.tags = tags;
    entry.updatedAt = Date.now();
    this.saveDatabase();
    return entry;
  }

  /**
   * Update rating for a trade
   */
  updateRating(tradeId: string, rating: number): JournalEntry | null {
    const entry = this.getEntryByTradeId(tradeId);
    if (!entry) return null;

    entry.rating = Math.min(5, Math.max(1, rating));
    entry.updatedAt = Date.now();
    this.saveDatabase();
    return entry;
  }

  /**
   * Update lesson learned for a trade
   */
  updateLesson(tradeId: string, lesson: string): JournalEntry | null {
    const entry = this.getEntryByTradeId(tradeId);
    if (!entry) return null;

    entry.lessonLearned = lesson;
    entry.updatedAt = Date.now();
    this.saveDatabase();
    return entry;
  }

  /**
   * Delete journal entry
   */
  deleteEntry(tradeId: string): boolean {
    const index = this.db.entries.findIndex(e => e.tradeId === tradeId);
    if (index === -1) return false;

    this.db.entries.splice(index, 1);
    this.saveDatabase();
    return true;
  }

  // ============ Tags ============

  /**
   * Get all tags
   */
  getAllTags(): TradeTag[] {
    return this.db.tags;
  }

  /**
   * Create a new tag
   */
  createTag(name: string, color: string): TradeTag {
    const id = name.toLowerCase().replace(/\s+/g, '-');
    const existing = this.db.tags.find(t => t.id === id);
    if (existing) return existing;

    const tag: TradeTag = { id, name, color };
    this.db.tags.push(tag);
    this.saveDatabase();
    return tag;
  }

  /**
   * Delete a tag
   */
  deleteTag(tagId: string): boolean {
    const index = this.db.tags.findIndex(t => t.id === tagId);
    if (index === -1) return false;

    // Remove tag from all entries
    for (const entry of this.db.entries) {
      entry.tags = entry.tags.filter(t => t !== tagId);
    }

    this.db.tags.splice(index, 1);
    this.saveDatabase();
    return true;
  }

  // ============ Statistics ============

  /**
   * Calculate journal statistics, optionally filtered by botId
   */
  getStatistics(botId?: string): {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    avgWin: number;
    avgLoss: number;
    bestTrade: JournalEntry | null;
    worstTrade: JournalEntry | null;
    avgRating: number;
    tradesByAsset: { [asset: string]: number };
    tradesByTag: { [tag: string]: number };
  } {
    let entries = this.db.entries;
    if (botId) {
      entries = entries.filter(e => e.botId === botId);
    }
    const wins = entries.filter(e => (e.pnlUsdc || 0) > 0);
    const losses = entries.filter(e => (e.pnlUsdc || 0) < 0);

    const totalPnL = entries.reduce((sum, e) => sum + (e.pnlUsdc || 0), 0);
    const totalWinPnL = wins.reduce((sum, e) => sum + (e.pnlUsdc || 0), 0);
    const totalLossPnL = Math.abs(losses.reduce((sum, e) => sum + (e.pnlUsdc || 0), 0));

    const ratingsCount = entries.filter(e => e.rating).length;
    const ratingsSum = entries.reduce((sum, e) => sum + (e.rating || 0), 0);

    const tradesByAsset: { [asset: string]: number } = {};
    const tradesByTag: { [tag: string]: number } = {};

    for (const entry of entries) {
      tradesByAsset[entry.asset] = (tradesByAsset[entry.asset] || 0) + 1;
      for (const tag of entry.tags) {
        tradesByTag[tag] = (tradesByTag[tag] || 0) + 1;
      }
    }

    // Find best and worst trades
    const sortedByPnL = [...entries].sort((a, b) => (b.pnlUsdc || 0) - (a.pnlUsdc || 0));
    const bestTrade = sortedByPnL[0] || null;
    const worstTrade = sortedByPnL[sortedByPnL.length - 1] || null;

    return {
      totalTrades: entries.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: entries.length > 0 ? wins.length / entries.length : 0,
      totalPnL,
      avgWin: wins.length > 0 ? totalWinPnL / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLossPnL / losses.length : 0,
      bestTrade,
      worstTrade,
      avgRating: ratingsCount > 0 ? ratingsSum / ratingsCount : 0,
      tradesByAsset,
      tradesByTag,
    };
  }

  /**
   * Import trades from CSV data for a specific bot
   */
  importFromCsv(botId: string, trades: Array<{
    tradeId: string;
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
  }>): number {
    let imported = 0;

    for (const trade of trades) {
      const existing = this.getEntryByTradeId(trade.tradeId);
      if (!existing) {
        this.upsertEntry({
          ...trade,
          botId,
          notes: '',
          tags: [],
        });
        imported++;
      }
    }

    return imported;
  }
}
