import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../src/journal/EventStore';
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

  it('clear() empties the file rather than merging it back', () => {
    const store = new EventStore({ dataDir, flushThreshold: 1 });
    store.append(makeEvent('doomed', 1000));
    store.clear();

    expect(readEvents(dataDir)).toEqual([]);
  });
});
