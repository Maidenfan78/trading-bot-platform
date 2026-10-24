import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore, withLock } from '../src/journal/EventStore';
import type { JournalEvent } from '../src/journal/types';

function makeEvent(id: string, timestamp: number): JournalEvent {
  return {
    id,
    timestamp,
    botId: 'test-bot',
    mode: 'PAPER',
    category: 'CYCLE',
    type: 'CYCLE_START',
    payload: {},
  } as unknown as JournalEvent;
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eventstore-'));
}

function readEvents(dataDir: string): JournalEvent[] {
  const raw = fs.readFileSync(path.join(dataDir, 'events.json'), 'utf-8');
  return JSON.parse(raw).events as JournalEvent[];
}

describe('EventStore durability', () => {
  let dataDir: string;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    dataDir = freshDir();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves no temp file behind after a write', () => {
    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('a', 1000));

    const strays = fs
      .readdirSync(dataDir)
      .filter((f) => f.includes('.tmp'));
    expect(strays).toEqual([]);
    expect(readEvents(dataDir).map((e) => e.id)).toEqual(['a']);
  });

  it('does not drop events written by another process since it loaded', () => {
    // Two stores on one data dir, as three bots on the Pi genuinely are.
    const first = new EventStore({ dataDir, flushThreshold: 1 });
    const second = new EventStore({ dataDir, flushThreshold: 1 });

    first.append(makeEvent('from-first', 1000));
    second.append(makeEvent('from-second', 2000));

    // Before the merge fix, second's whole-array overwrite erased 'from-first'.
    const ids = readEvents(dataDir).map((e) => e.id);
    expect(ids).toContain('from-first');
    expect(ids).toContain('from-second');
  });

  it('excludes a second holder for the whole critical section', () => {
    // The merge above still loses events if two savers interleave: both read
    // the same disk state, then the second rename wins. What prevents that is
    // the lock covering read-and-write as one section, so assert exactly that -
    // nobody else gets in while fn is running.
    const lockFile = path.join(dataDir, 'events.lock');
    let inner: boolean | undefined;

    const outer = withLock(lockFile, 150, () => {
      expect(fs.existsSync(lockFile)).toBe(true);
      inner = withLock(lockFile, 150, () => undefined);
    });

    expect(outer).toBe(true);
    expect(inner).toBe(false);
    // Released again, so the next save is not blocked.
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('releases the lock even when the critical section throws', () => {
    const lockFile = path.join(dataDir, 'events.lock');
    expect(() =>
      withLock(lockFile, 150, () => {
        throw new Error('write blew up');
      })
    ).toThrow('write blew up');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('steals a stale lock so a bot killed mid-save cannot block the journal', () => {
    const lockFile = path.join(dataDir, 'events.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: 0 }));
    // Backdate well past the 30s stale threshold.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);

    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('after-steal', 1000));

    expect(readEvents(dataDir).map((e) => e.id)).toEqual(['after-steal']);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('keeps events queued when the lock cannot be taken', () => {
    const lockFile = path.join(dataDir, 'events.lock');
    // Short timeout so the test does not sit through the 5s production wait.
    const store = new EventStore({ dataDir, flushThreshold: 1, lockTimeoutMs: 150 });

    // A fresh lock held by someone else: not stale, so not stealable.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() }));
    store.append(makeEvent('blocked', 1000));

    // Nothing was written, and the failure was reported rather than swallowed.
    expect(fs.existsSync(path.join(dataDir, 'events.json'))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    // Once the holder goes away the queued event still lands.
    fs.unlinkSync(lockFile);
    store.flush();
    expect(readEvents(dataDir).map((e) => e.id)).toEqual(['blocked']);
  });

  it('dedupes by id rather than duplicating on repeated flushes', () => {
    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('only-once', 1000));
    store.flush();
    store.flush();

    expect(readEvents(dataDir).filter((e) => e.id === 'only-once')).toHaveLength(1);
  });

  it('caps the file at maxEventsInMemory so it stays bounded', () => {
    const store = new EventStore({
      dataDir,
      maxEventsInMemory: 5,
      flushThreshold: 1,
    });
    for (let i = 0; i < 12; i++) {
      store.append(makeEvent(`e${i}`, 1000 + i));
    }

    const onDisk = readEvents(dataDir);
    expect(onDisk).toHaveLength(5);
    // Most recent kept.
    expect(onDisk.map((e) => e.id)).toEqual(['e7', 'e8', 'e9', 'e10', 'e11']);
  });

  it('quarantines a corrupt events file instead of overwriting it', () => {
    const eventFile = path.join(dataDir, 'events.json');
    fs.writeFileSync(eventFile, '{"version":1,"events":[{"id":"salvage-me"}]}GARBAGE');
    const before = fs.readFileSync(eventFile, 'utf-8');

    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('after-recovery', 5000));

    const quarantined = fs
      .readdirSync(dataDir)
      .filter((f) => f.includes('.corrupt-'));
    expect(quarantined).toHaveLength(1);

    // The unparseable bytes survive untouched - this is the whole point.
    const preserved = fs.readFileSync(path.join(dataDir, quarantined[0]), 'utf-8');
    expect(preserved).toBe(before);

    // And the store carries on with a clean file.
    expect(readEvents(dataDir).map((e) => e.id)).toEqual(['after-recovery']);
  });

  it('archive still shrinks the main file (merge must not resurrect archived events)', () => {
    const store = new EventStore({
      dataDir,
      archiveAfterDays: 30,
      flushThreshold: 1,
    });

    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    store.append(makeEvent('ancient', old));
    store.append(makeEvent('recent', Date.now()));

    const result = store.archive();
    expect(result.archivedCount).toBe(1);

    // Regression: save() merges with disk by default, so archive() had to opt
    // out or it would read the archived event straight back in.
    const ids = readEvents(dataDir).map((e) => e.id);
    expect(ids).toEqual(['recent']);
    expect(ids).not.toContain('ancient');
  });

  it('a long-lived writer does not resurrect what the archiver removed', () => {
    // The production shape on 2026-10-24: bots up since before an archive run
    // still held the archived events in memory and re-added them on their next
    // flush, so the live file held 43 days of history with 210 events also
    // sitting in events-2026-09.json. The archive could never shrink the file
    // while a bot was up.
    const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000;

    const seed = new EventStore({ dataDir, flushThreshold: 1 });
    seed.append(makeEvent('ancient', ancient));
    seed.append(makeEvent('recent', Date.now()));

    // A bot that loaded BEFORE the archive run: 'ancient' is in its cache.
    const longLivedBot = new EventStore({ dataDir, flushThreshold: 1 });

    const archiver = new EventStore({ dataDir, flushThreshold: 1, archiveAfterDays: 30 });
    expect(archiver.archive().archivedCount).toBe(1);
    expect(readEvents(dataDir).map((e) => e.id)).toEqual(['recent']);

    // The bot keeps running and flushes a new event.
    longLivedBot.append(makeEvent('after-archive', Date.now()));

    const ids = readEvents(dataDir).map((e) => e.id);
    expect(ids).toContain('recent');
    expect(ids).toContain('after-archive');
    // The whole point: it must NOT have come back.
    expect(ids).not.toContain('ancient');
  });

  it('archive() keeps events another process appended since it loaded', () => {
    const archiver = new EventStore({
      dataDir,
      archiveAfterDays: 30,
      flushThreshold: 1,
    });
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    archiver.append(makeEvent('ancient', old));

    // A second bot writes while the archiver holds a stale in-memory view.
    const otherBot = new EventStore({ dataDir, flushThreshold: 1 });
    otherBot.append(makeEvent('written-during-archive', Date.now()));

    archiver.archive();

    // archive() writes with merge:false, so without refreshing from disk first
    // it would clobber the other bot's event.
    const ids = readEvents(dataDir).map((e) => e.id);
    expect(ids).toContain('written-during-archive');
    expect(ids).not.toContain('ancient');
  });

  it('clear() empties the file rather than merging it back', () => {
    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('doomed', 1000));
    store.clear();

    expect(readEvents(dataDir)).toEqual([]);
  });
});
