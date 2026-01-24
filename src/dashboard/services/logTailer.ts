/* eslint-disable no-console */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import type { LogEntry } from '../types';

/**
 * Log Tailer Service
 *
 * Reads and tails bot log files.
 */
export class LogTailer {
  private tailProcesses: Map<string, ChildProcess> = new Map();

  /**
   * Read last N lines from log file
   */
  readLastLines(logPath: string, lines: number = 100): LogEntry[] {
    if (!existsSync(logPath)) {
      console.warn(`Log file not found: ${logPath}`);
      return [];
    }

    try {
      const content = readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const lastLines = allLines.slice(-lines);

      return lastLines.map(line => this.parseLogLine(line)).filter(Boolean) as LogEntry[];
    } catch (error) {
      console.error(`Failed to read log file ${logPath}:`, error);
      return [];
    }
  }

  /**
   * Start tailing a log file
   */
  startTailing(logPath: string, onLine: (entry: LogEntry) => void): void {
    if (this.tailProcesses.has(logPath)) {
      console.log(`Already tailing ${logPath}`);
      return;
    }

    if (!existsSync(logPath)) {
      console.warn(`Cannot tail non-existent file: ${logPath}`);
      return;
    }

    console.log(`Starting tail for ${logPath}`);

    const tail = spawn('tail', ['-f', '-n', '0', logPath]);

    tail.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = this.parseLogLine(line);
        if (entry) {
          onLine(entry);
        }
      }
    });

    tail.stderr.on('data', (data) => {
      console.error(`Tail stderr for ${logPath}:`, data.toString());
    });

    tail.on('error', (error) => {
      console.error(`Tail process error for ${logPath}:`, error);
    });

    tail.on('exit', (code, signal) => {
      console.log(`Tail process exited for ${logPath}, code: ${code}, signal: ${signal}`);
      this.tailProcesses.delete(logPath);
    });

    this.tailProcesses.set(logPath, tail);
  }

  /**
   * Stop tailing a log file
   */
  stopTailing(logPath: string): void {
    const tail = this.tailProcesses.get(logPath);
    if (tail) {
      console.log(`Stopping tail for ${logPath}`);
      tail.kill();
      this.tailProcesses.delete(logPath);
    }
  }

  /**
   * Parse winston log line
   * Format: "2026-01-10 11:34:48 info: message"
   */
  private parseLogLine(line: string): LogEntry | null {
    if (!line || line.trim() === '') {
      return null;
    }

    // Try to parse winston format: "YYYY-MM-DD HH:MM:SS level: message"
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\w+): (.+)$/);

    if (match) {
      return {
        timestamp: match[1],
        level: match[2].toLowerCase(),
        message: match[3],
      };
    }

    // Fallback: treat as plain message
    return {
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      level: 'info',
      message: line,
    };
  }

  /**
   * Filter logs by level
   */
  filterByLevel(logs: LogEntry[], level: string): LogEntry[] {
    if (level === 'all') {
      return logs;
    }

    return logs.filter(log => log.level.toLowerCase() === level.toLowerCase());
  }

  /**
   * Search logs by keyword
   */
  searchLogs(logs: LogEntry[], keyword: string): LogEntry[] {
    if (!keyword || keyword.trim() === '') {
      return logs;
    }

    const search = keyword.toLowerCase();
    return logs.filter(log => log.message.toLowerCase().includes(search));
  }

  /**
   * Stop all tailing
   */
  closeAll(): void {
    console.log('Closing all log tailers...');
    for (const [path, tail] of this.tailProcesses) {
      tail.kill();
      console.log(`Closed tail for ${path}`);
    }
    this.tailProcesses.clear();
  }

  /**
   * Get list of active tails
   */
  getActiveTails(): string[] {
    return Array.from(this.tailProcesses.keys());
  }
}
