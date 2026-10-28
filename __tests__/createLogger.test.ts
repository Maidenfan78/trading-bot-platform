import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../src/core/createLogger';

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'createlogger-'));
}

/** Winston's File transport flushes asynchronously. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

describe('createLogger file transports (BUG-037)', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = freshDir();
  });

  afterEach(() => {
    // Restore any directory a test made read-only, or the cleanup fails.
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.chmodSync(path.join(logDir, entry.name), 0o700);
      }
    }
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('writes the log files by default', async () => {
    const log = createLogger({ botId: 'test', logDir, console: false });
    log.info('hello');
    await settle();

    const main = path.join(logDir, 'bot-test.log');
    expect(fs.existsSync(main)).toBe(true);
    expect(fs.readFileSync(main, 'utf-8')).toContain('hello');
  });

  it('writes no files when file: false', async () => {
    // Exactly what btc-trader passes. Its systemd units already persist stdout
    // and stderr to these paths via StandardOutput=append:, and a second writer
    // cannot open them because the unit runs as an unprivileged user while
    // systemd opened the files as root.
    const log = createLogger({ botId: 'test', logDir, console: true, file: false });
    log.info('hello');
    log.error('boom');
    await settle();

    expect(fs.existsSync(path.join(logDir, 'bot-test.log'))).toBe(false);
    expect(fs.existsSync(path.join(logDir, 'error-test.log'))).toBe(false);
  });

  it('an unopenable transport does not make logging throw', async () => {
    // NOTE on what this does and does not cover. It pins that an unopenable
    // File transport is tolerated rather than throwing - verified to pass
    // against the version with no transport error handler, so winston already
    // swallows the open failure itself.
    //
    // It therefore does NOT cover the BUG-037 mechanism. In production the
    // logger went quiet after ~17h for the 4H bots and 4+ days for the 1D bot,
    // i.e. in proportion to write volume, which points at entries queueing
    // against a transport whose stream never opens and the logger's shared
    // pipeline stalling for every transport. Reproducing that needs hours of
    // writes, not a unit test. The fix is `file: false` - not having the
    // impossible transport at all - and that is what the test above pins.
    const locked = path.join(logDir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500); // no new files in here

    const mainLog = path.join(logDir, 'bot-test.log');
    const log = createLogger({
      botId: 'test',
      logDir,
      console: false,
      logFile: mainLog,
      errorLogFile: path.join(locked, 'error-test.log'),
    });

    expect(() => log.info('still speaking')).not.toThrow();
    expect(() => log.error('and still erroring')).not.toThrow();
    await settle();

    const written = fs.readFileSync(mainLog, 'utf-8');
    expect(written).toContain('still speaking');
    expect(written).toContain('and still erroring');
  });
});
