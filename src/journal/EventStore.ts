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
  lockTimeoutMs: 5000,
};

const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 40;

/** Synchronous sleep, so the lock poll doesn't yield the file to a racing process. */
function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy-wait; the waits here are tens of milliseconds
  }
}

/**
 * Run `fn` while holding an exclusive lock on `lockFile`. Synchronous, so `fn`
 * must not await. Returns false if the lock could not be taken in time.
 *
 * Several bots share one events file and each save is a read-modify-write
 * (merge with disk, then rename over it). Without a lock two bots that finish
 * in the same second both read the same disk state and the second rename wins,
 * so the first bot's events vanish - no corruption, just silent loss. Observed
 * 2026-10-24: tdfi's 08:24Z cycle left no events while tcf2's identical-second
 * cycle left five.
 *
 * Steals a lock older than LOCK_STALE_MS, so a bot killed mid-save cannot
 * block the journal forever.
 */
export function withLock(lockFile: string, timeoutMs: number, fn: () => void): boolean {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx'); // O_CREAT | O_EXCL - atomic
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      break; // acquired
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue; // stale holder - retry immediately
        }
      } catch {
        continue; // lock vanished between calls - retry
      }
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_POLL_MS);
    }
  }

  try {
    fn();
    return true;
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // already gone - fine
    }
  }
}

export class EventStore {
  private config: Required<EventStoreConfig>;
  private events: JournalEvent[] = [];
  private pendingWrites: JournalEvent[] = [];
  private eventFile: string;
  private lockFile: string;
  private archiveDir: string;
  private loaded = false;
  private readOnly = false;

  constructor(config: EventStoreConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventFile = path.join(config.dataDir, 'events.json');
    this.lockFile = path.join(config.dataDir, 'events.lock');
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

  /**
   * Write JSON via a temp file + rename, which is atomic on one filesystem.
   *
   * A plain writeFileSync truncates first, so a crash or a second writer
   * part-way through leaves a half-written file. That is how this store lost
   * history once already: the partial file failed to parse, load() started
   * empty, and the next save() overwrote the remains.
   */
  private writeJsonAtomic(file: string, db: EventDatabase): void {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
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
      // Never start empty *on top of* a file we could not parse - the next
      // save() would overwrite it and the history would be gone for good.
      // Move it aside so it stays salvageable, and say so loudly.
      const quarantine = `${this.eventFile}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(this.eventFile, quarantine);
        console.error(
          `Failed to parse events file. Moved it to ${quarantine} and started ` +
            'empty; those events are recoverable from that file.',
          error
        );
      } catch (renameError) {
        // Could not even move it. Overwriting would destroy it, so drop
        // journal writes for this run instead and keep the file intact.
        this.readOnly = true;
        console.error(
          'Failed to parse events file AND failed to move it aside; refusing ' +
            'to overwrite it. Journal writes are disabled for this run.',
          error,
          renameError
        );
      }
      this.events = [];
    }

    this.loaded = true;
  }

  /**
   * Persist to disk. Returns false if nothing was written, so flush() can keep
   * the events queued for the next attempt instead of dropping them.
   *
   * The merge and the write must happen under one lock: they are a
   * read-modify-write against a file other bot processes also write, and
   * splitting them is what loses events (see withLock).
   */
  private save(options: { merge?: boolean } = {}): boolean {
    if (this.readOnly) return false;

    const merge = options.merge !== false;
    try {
      const wrote = withLock(this.lockFile, this.config.lockTimeoutMs, () => {
        const events = merge ? this.mergeWithDisk() : this.events;
        const db: EventDatabase = {
          version: 1,
          events,
          lastUpdated: Date.now(),
        };
        this.writeJsonAtomic(this.eventFile, db);
        // Keep the in-memory view equal to what is now on disk.
        this.events = events;
      });
      if (!wrote) {
        console.error(
          `Could not take the journal lock within ${this.config.lockTimeoutMs}ms ` +
            `(${this.lockFile}); events stay queued for the next flush.`
        );
      }
      return wrote;
    } catch (error) {
      console.error('Failed to save events file:', error);
      return false;
    }
  }

  /**
   * Union what is on disk with this process's **unflushed** events, deduped by
   * id. Disk is authoritative for everything else.
   *
   * Several bots share one data dir. Each holds its own in-memory copy and
   * writes the whole array, so a plain overwrite silently drops whatever
   * another process appended since this one loaded - no corruption needed,
   * just lost events. Capped to the in-memory limit so the file stays bounded.
   *
   * It merges `pendingWrites`, not `this.events`, and the difference is
   * load-bearing. `this.events` is a query cache holding everything this
   * process has seen since it loaded, including events that have since been
   * **archived out of the file by another process**. Merging all of it put them
   * straight back: on 2026-10-24 the live file held 1819 events spanning 43
   * days with 210 of them also sitting in `events-2026-09.json`, because the
   * bots had been running since before the Oct 18 archive run and re-added what
   * it removed on their next flush. The archive could never shrink the file
   * while a long-lived bot was up, so it grew unbounded between restarts and
   * analyses that read both files double-counted.
   *
   * `pendingWrites` is exactly this process's contribution that disk might not
   * have yet; anything else it holds either came from disk or was already
   * flushed, and may have been deliberately removed since.
   *
   * Callers that mean to *shrink* the file (archive, clear) still pass
   * `{ merge: false }`, so they write their own trimmed array rather than
   * re-reading the file they are shrinking.
   */
  private mergeWithDisk(): JournalEvent[] {
    let onDisk: JournalEvent[] = [];
    try {
      if (fs.existsSync(this.eventFile)) {
        const db: EventDatabase = JSON.parse(
          fs.readFileSync(this.eventFile, 'utf-8')
        );
        onDisk = db.events || [];
      }
    } catch {
      // Not fatal: this process still has its unflushed events, and the atomic
      // write replaces the file wholesale. load() quarantines at startup.
      onDisk = [];
    }

    const byId = new Map<string, JournalEvent>();
    for (const event of onDisk) byId.set(event.id, event);
    for (const event of this.pendingWrites) byId.set(event.id, event);

    const merged = Array.from(byId.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );
    return merged.length > this.config.maxEventsInMemory
      ? merged.slice(-this.config.maxEventsInMemory)
      : merged;
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
      // Only drop the queue once the write actually landed. The events also
      // live in this.events, so a later merge would pick them up anyway, but
      // keeping them queued makes the next flush retry immediately.
      if (this.save()) {
        this.pendingWrites = [];
      }
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
    // Take disk as the starting point. This writes with `merge: false` (it has
    // to, or it would read the archived events straight back in), so without
    // re-reading first, anything another bot appended since this process loaded
    // would be dropped - the same event loss this class was fixed for. With
    // nothing pending in an archive run, this is simply "load the current file".
    this.events = this.mergeWithDisk();

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

      this.writeJsonAtomic(archiveFile, archiveDb);
      archivedTo.push(archiveFile);
    }

    // Remove archived events from main store. No merge: these events were
    // just written to the archive, and merging would pull them back in.
    this.events = this.events.filter((e) => e.timestamp >= cutoffTime);
    this.save({ merge: false });

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
    this.save({ merge: false });
  }
}
