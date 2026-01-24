/* eslint-disable no-console */
/**
 * EventStore - Persistent storage for journal events
 *
 * Handles storage, querying, and archival of journal events.
 * Uses JSON files for simplicity and easy inspection.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  JournalEvent,
  EventDatabase,
  EventStoreConfig,
  EventQueryFilters,
  EventQueryResult,
} from './types.js';

const DEFAULT_CONFIG: Required<Omit<EventStoreConfig, 'dataDir'>> = {
  maxEventsInMemory: 10000,
  archiveAfterDays: 30,
  flushThreshold: 10,
};

export class EventStore {
  private config: Required<EventStoreConfig>;
  private events: JournalEvent[] = [];
  private pendingWrites: JournalEvent[] = [];
  private eventFile: string;
  private archiveDir: string;
  private loaded = false;

  constructor(config: EventStoreConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventFile = path.join(config.dataDir, 'events.json');
    this.archiveDir = path.join(config.dataDir, 'events-archive');

    this.ensureDirectories();
    this.load();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  private load(): void {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.eventFile)) {
        const data = fs.readFileSync(this.eventFile, 'utf-8');
        const db: EventDatabase = JSON.parse(data);
        this.events = db.events || [];

        // Trim to max in-memory limit (keep most recent)
        if (this.events.length > this.config.maxEventsInMemory) {
          this.events = this.events.slice(-this.config.maxEventsInMemory);
        }
      }
    } catch (error) {
      console.error('Failed to load events file:', error);
      this.events = [];
    }

    this.loaded = true;
  }

  private save(): void {
    try {
      const db: EventDatabase = {
        version: 1,
        events: this.events,
        lastUpdated: Date.now(),
      };
      fs.writeFileSync(this.eventFile, JSON.stringify(db, null, 2));
    } catch (error) {
      console.error('Failed to save events file:', error);
    }
  }

  /**
   * Append a single event
   */
  append(event: JournalEvent): void {
    this.events.push(event);
    this.pendingWrites.push(event);

    // Trim if over limit
    if (this.events.length > this.config.maxEventsInMemory) {
      this.events = this.events.slice(-this.config.maxEventsInMemory);
    }

    // Flush if threshold reached
    if (this.pendingWrites.length >= this.config.flushThreshold) {
      this.flush();
    }
  }

  /**
   * Append multiple events at once
   */
  appendBatch(events: JournalEvent[]): void {
    for (const event of events) {
      this.events.push(event);
      this.pendingWrites.push(event);
    }

    // Trim if over limit
    if (this.events.length > this.config.maxEventsInMemory) {
      this.events = this.events.slice(-this.config.maxEventsInMemory);
    }

    this.flush();
  }

  /**
   * Force write pending events to disk
   */
  flush(): void {
    if (this.pendingWrites.length > 0) {
      this.save();
      this.pendingWrites = [];
    }
  }

  /**
   * Query events with filters
   */
  query(filters: EventQueryFilters = {}): EventQueryResult {
    let results = [...this.events];

    // Apply filters
    if (filters.botId) {
      results = results.filter((e) => e.botId === filters.botId);
    }
    if (filters.asset) {
      results = results.filter((e) => e.asset === filters.asset);
    }
    if (filters.category) {
      results = results.filter((e) => e.category === filters.category);
    }
    if (filters.types && filters.types.length > 0) {
      results = results.filter((e) => filters.types!.includes(e.type));
    }
    if (filters.startTime) {
      results = results.filter((e) => e.timestamp >= filters.startTime!);
    }
    if (filters.endTime) {
      results = results.filter((e) => e.timestamp <= filters.endTime!);
    }
    if (filters.cycleId) {
      results = results.filter((e) => e.cycleId === filters.cycleId);
    }
    if (filters.positionId) {
      results = results.filter((e) => e.positionId === filters.positionId);
    }
    if (filters.signalId) {
      results = results.filter((e) => e.signalId === filters.signalId);
    }
    if (filters.mode) {
      results = results.filter((e) => e.mode === filters.mode);
    }

    // Sort by timestamp descending (most recent first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    const total = results.length;

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 50;
    results = results.slice(offset, offset + limit);

    return {
      events: results,
      total,
      hasMore: offset + results.length < total,
    };
  }

  /**
   * Get all events for a specific cycle
   */
  getCycleEvents(cycleId: string): JournalEvent[] {
    return this.events
      .filter((e) => e.cycleId === cycleId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all events for a specific position
   */
  getPositionEvents(positionId: string): JournalEvent[] {
    return this.events
      .filter((e) => e.positionId === positionId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get unique values for filter dropdowns
   */
  getFilterOptions(): {
    botIds: string[];
    assets: string[];
    categories: string[];
    types: string[];
  } {
    const botIds = new Set<string>();
    const assets = new Set<string>();
    const categories = new Set<string>();
    const types = new Set<string>();

    for (const event of this.events) {
      botIds.add(event.botId);
      assets.add(event.asset);
      categories.add(event.category);
      types.add(event.type);
    }

    return {
      botIds: Array.from(botIds).sort(),
      assets: Array.from(assets).sort(),
      categories: Array.from(categories).sort(),
      types: Array.from(types).sort(),
    };
  }

  /**
   * Archive old events to monthly files
   */
  archive(): { archivedCount: number; archivedTo: string[] } {
    const cutoffTime =
      Date.now() - this.config.archiveAfterDays * 24 * 60 * 60 * 1000;
    const toArchive = this.events.filter((e) => e.timestamp < cutoffTime);

    if (toArchive.length === 0) {
      return { archivedCount: 0, archivedTo: [] };
    }

    // Group by month
    const byMonth = new Map<string, JournalEvent[]>();
    for (const event of toArchive) {
      const date = new Date(event.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(monthKey)) {
        byMonth.set(monthKey, []);
      }
      byMonth.get(monthKey)!.push(event);
    }

    const archivedTo: string[] = [];

    // Write to archive files
    for (const [monthKey, events] of byMonth) {
      const archiveFile = path.join(this.archiveDir, `events-${monthKey}.json`);

      // Merge with existing archive if present
      let existingEvents: JournalEvent[] = [];
      if (fs.existsSync(archiveFile)) {
        try {
          const data = fs.readFileSync(archiveFile, 'utf-8');
          const db: EventDatabase = JSON.parse(data);
          existingEvents = db.events || [];
        } catch {
          // Ignore parse errors, start fresh
        }
      }

      // Combine and dedupe by id
      const combined = [...existingEvents, ...events];
      const deduped = Array.from(
        new Map(combined.map((e) => [e.id, e])).values()
      );

      const archiveDb: EventDatabase = {
        version: 1,
        events: deduped.sort((a, b) => a.timestamp - b.timestamp),
        lastUpdated: Date.now(),
      };

      fs.writeFileSync(archiveFile, JSON.stringify(archiveDb, null, 2));
      archivedTo.push(archiveFile);
    }

    // Remove archived events from main store
    this.events = this.events.filter((e) => e.timestamp >= cutoffTime);
    this.save();

    return { archivedCount: toArchive.length, archivedTo };
  }

  /**
   * Get event count
   */
  count(): number {
    return this.events.length;
  }

  /**
   * Get most recent events
   */
  recent(limit = 10): JournalEvent[] {
    return [...this.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * Clear all events (use with caution)
   */
  clear(): void {
    this.events = [];
    this.pendingWrites = [];
    this.save();
  }
}
