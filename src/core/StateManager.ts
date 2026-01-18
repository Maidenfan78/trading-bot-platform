import fs from 'fs';
import { Logger } from '../types';

/**
 * Generic State Manager
 *
 * Handles loading, saving, and updating state files for bots.
 * Provides atomic writes and error recovery.
 *
 * @template T - State type (must extend object)
 */
export class StateManager<T extends object> {
  private filePath: string;
  private state: T;
  private logger?: Logger;
  private defaultState: T;

  /**
   * Create a new StateManager instance
   *
   * @param filePath - Path to the state file
   * @param defaultState - Default state if file doesn't exist
   * @param logger - Optional logger instance
   */
  constructor(filePath: string, defaultState: T, logger?: Logger) {
    this.filePath = filePath;
    this.defaultState = defaultState;
    this.logger = logger;
    this.state = { ...defaultState };
  }

  /**
   * Load state from file
   * Returns default state if file doesn't exist or is invalid
   */
  async load(): Promise<T> {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger?.info(`State file not found, using defaults: ${this.filePath}`);
        this.state = { ...this.defaultState };
        await this.save();
        return this.state;
      }

      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);

      // Merge with defaults to handle missing fields in saved state
      this.state = { ...this.defaultState, ...parsed };

      this.logger?.info(`State loaded from: ${this.filePath}`);
      return this.state;
    } catch (error: any) {
      this.logger?.error(`Failed to load state: ${error.message}`);
      this.state = { ...this.defaultState };
      return this.state;
    }
  }

  /**
   * Save current state to file
   * Uses atomic write (write to temp, then rename)
   */
  async save(): Promise<void> {
    try {
      const tempPath = `${this.filePath}.tmp`;
      const content = JSON.stringify(this.state, null, 2);

      // Write to temp file first
      fs.writeFileSync(tempPath, content, 'utf-8');

      // Rename to actual file (atomic on most systems)
      fs.renameSync(tempPath, this.filePath);

      this.logger?.debug?.(`State saved to: ${this.filePath}`);
    } catch (error: any) {
      this.logger?.error(`Failed to save state: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current state
   */
  getState(): T {
    return { ...this.state };
  }

  /**
   * Update state with partial changes
   * Automatically saves after update
   */
  async update(changes: Partial<T>): Promise<void> {
    this.state = { ...this.state, ...changes };
    await this.save();
  }

  /**
   * Set state completely
   * Automatically saves after set
   */
  async setState(newState: T): Promise<void> {
    this.state = { ...newState };
    await this.save();
  }

  /**
   * Get a specific field from state
   */
  get<K extends keyof T>(key: K): T[K] {
    return this.state[key];
  }

  /**
   * Set a specific field in state
   * Automatically saves after set
   */
  async set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    this.state[key] = value;
    await this.save();
  }

  /**
   * Reset state to defaults
   * Automatically saves after reset
   */
  async reset(): Promise<void> {
    this.state = { ...this.defaultState };
    await this.save();
    this.logger?.info('State reset to defaults');
  }

  /**
   * Check if state file exists
   */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * Get file path
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Create a backup of current state
   */
  async backup(suffix: string = 'backup'): Promise<string> {
    const backupPath = `${this.filePath}.${suffix}`;
    const content = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(backupPath, content, 'utf-8');
    this.logger?.info(`State backup created: ${backupPath}`);
    return backupPath;
  }
}
