import fs from 'fs';
import dotenv from 'dotenv';

const PLACEHOLDER_PATTERN = /(your_api_key|your_secret_key_here)/i;

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERN.test(trimmed);
}

function applyParsedEnv(parsed: Record<string, string>, override: boolean): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlaceholder(value)) {
      continue;
    }
    if (!override && process.env[key]) {
      continue;
    }
    process.env[key] = value;
  }
}

function loadEnvFile(path: string, override: boolean): void {
  if (!fs.existsSync(path)) {
    return;
  }
  const parsed = dotenv.parse(fs.readFileSync(path));
  applyParsedEnv(parsed, override);
}

/**
 * Load environment configuration with layered overrides
 *
 * 1. Load global env file (non-override mode)
 * 2. If BOT_ENV_FILE is set, load that file and override values
 * 3. Otherwise, optionally load fallback file (non-override)
 *
 * @param globalPath - Path to global .env file
 * @param fallbackPath - Optional fallback .env file path
 */
export function loadEnvConfig(globalPath: string, fallbackPath?: string): void {
  loadEnvFile(globalPath, false);

  if (process.env.BOT_ENV_FILE) {
    loadEnvFile(process.env.BOT_ENV_FILE, true);
    return;
  }

  if (fallbackPath && fallbackPath !== globalPath) {
    loadEnvFile(fallbackPath, false);
  }
}

/**
 * Get required environment variable or throw
 */
export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

/**
 * Get optional environment variable with default
 */
export function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get numeric environment variable
 */
export function getNumericEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get boolean environment variable
 */
export function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return value === 'true' || value === '1' || value === 'yes';
}
