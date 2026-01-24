import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvConfig } from '../src/utils/env';

function writeTempEnv(contents: string): string {
  const filePath = path.join(os.tmpdir(), `env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

describe('loadEnvConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads global env and fallback when BOT_ENV_FILE is not set', () => {
    const globalPath = writeTempEnv('ALPHA=one\nBETA=two\n');
    const fallbackPath = writeTempEnv('BETA=override\nGAMMA=three\n');

    delete process.env.BOT_ENV_FILE;
    loadEnvConfig(globalPath, fallbackPath);

    expect(process.env.ALPHA).toBe('one');
    expect(process.env.BETA).toBe('two');
    expect(process.env.GAMMA).toBe('three');

    fs.unlinkSync(globalPath);
    fs.unlinkSync(fallbackPath);
  });

  it('uses BOT_ENV_FILE to override values', () => {
    const globalPath = writeTempEnv('ALPHA=one\nBETA=two\n');
    const overridePath = writeTempEnv('BETA=override\nDELTA=four\n');

    process.env.BOT_ENV_FILE = overridePath;
    loadEnvConfig(globalPath);

    expect(process.env.ALPHA).toBe('one');
    expect(process.env.BETA).toBe('override');
    expect(process.env.DELTA).toBe('four');

    fs.unlinkSync(globalPath);
    fs.unlinkSync(overridePath);
  });
});
