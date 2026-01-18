import { watch, FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'fs';
import { BotState, MultiAssetBotState } from '../types';

type StateChangeCallback = (botName: string, state: BotState | MultiAssetBotState) => void;

/**
 * State Watcher Service
 *
 * Watches bot state files for changes and notifies callbacks.
 */
export class StateWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private callbacks: StateChangeCallback[] = [];
  private lastStates: Map<string, BotState | MultiAssetBotState> = new Map();

  /**
   * Register a callback to be called when state changes
   */
  onStateChange(callback: StateChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Start watching a bot's state file
   */
  watchBotState(botName: string, filePath: string): void {
    if (!existsSync(filePath)) {
      console.warn(`State file not found: ${filePath}. Will create watcher anyway.`);
    }

    console.log(`Setting up state watcher for ${botName}: ${filePath}`);

    const watcher = watch(filePath, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    watcher.on('add', () => this.handleStateChange(botName, filePath));
    watcher.on('change', () => this.handleStateChange(botName, filePath));

    watcher.on('error', (error) => {
      console.error(`State watcher error for ${botName}:`, error);
    });

    this.watchers.set(botName, watcher);

    // Read initial state
    this.handleStateChange(botName, filePath);
  }

  /**
   * Handle state file change with debouncing
   */
  private handleStateChange(botName: string, filePath: string): void {
    try {
      const state = this.readState(filePath);

      // Check if state actually changed
      const lastState = this.lastStates.get(botName);
      if (lastState && JSON.stringify(lastState) === JSON.stringify(state)) {
        return; // No change, skip callbacks
      }

      this.lastStates.set(botName, state);
      console.log(`State updated for ${botName}`);

      // Notify all callbacks
      for (const callback of this.callbacks) {
        try {
          callback(botName, state);
        } catch (error) {
          console.error(`Error in state change callback:`, error);
        }
      }
    } catch (error) {
      console.error(`Failed to read state for ${botName}:`, error);
    }
  }

  /**
   * Read and parse state file
   */
  private readState(filePath: string): BotState | MultiAssetBotState {
    if (!existsSync(filePath)) {
      // Return default state if file doesn't exist yet
      return {
        lastProcessedCandleTime: 0,
        lastTradeTime: 0,
        openLegs: [],
        totalTradesToday: 0,
        lastDayReset: new Date().toISOString().split('T')[0],
      };
    }

    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  }

  /**
   * Get current state for a bot
   */
  getCurrentState(botName: string): BotState | MultiAssetBotState | null {
    return this.lastStates.get(botName) || null;
  }

  /**
   * Stop watching a bot's state
   */
  unwatchBot(botName: string): void {
    const watcher = this.watchers.get(botName);
    if (watcher) {
      watcher.close();
      this.watchers.delete(botName);
      this.lastStates.delete(botName);
      console.log(`Stopped watching ${botName}`);
    }
  }

  /**
   * Stop all watchers
   */
  close(): void {
    for (const [botName, watcher] of this.watchers) {
      watcher.close();
      console.log(`Closed watcher for ${botName}`);
    }
    this.watchers.clear();
    this.lastStates.clear();
    this.callbacks = [];
  }
}
