/* eslint-disable no-console */
import winston from 'winston';
import path from 'path';
import fs from 'fs';
import type { Logger } from '../types';

/**
 * Logger Configuration
 */
export interface LoggerConfig {
  botId: string;
  logDir?: string;
  logLevel?: string;
  logFile?: string;
  errorLogFile?: string;
  console?: boolean;
  /**
   * Write the log files from this process (default true).
   *
   * Set it **false** when something else already persists stdout/stderr to
   * those paths - a systemd unit using `StandardOutput=append:` is the case
   * that bit btc-trader (BUG-037). Two writers for one path is not a
   * redundancy: under systemd the unit's descriptors are opened by root while
   * the service runs as an unprivileged user, so this transport can never open
   * the file.
   *
   * Observed consequence: the whole logger goes quiet, Console transport
   * included, after a time proportional to write volume - ~17h for the 4H bots
   * writing every 15 minutes, 4+ days for the 1D bot writing once a day - while
   * the process otherwise runs normally. Winston does not throw on the failed
   * open, so the likeliest mechanism is entries queueing against a stream that
   * never opens and stalling the logger's shared pipeline. The cure is not
   * having the impossible transport, which is what this flag is for.
   */
  file?: boolean;
}

/**
 * Create a Winston logger instance for a bot
 *
 * This factory creates consistent loggers for all bots, replacing the need
 * for individual logger-btc.ts, logger-4h.ts, etc. files.
 *
 * @param config - Logger configuration
 * @returns Logger instance
 */
export function createLogger(config: LoggerConfig): Logger {
  const {
    botId,
    logDir = path.join(process.cwd(), 'logs'),
    logLevel = process.env.LOG_LEVEL || 'info',
    logFile,
    errorLogFile,
    console: enableConsole = true,
    file: enableFiles = true,
  } = config;

  // Ensure logs directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Determine log file paths
  const mainLogFile = logFile || path.join(logDir, `bot-${botId}.log`);
  const errLogFile = errorLogFile || path.join(logDir, `error-${botId}.log`);

  // Build transports array
  const transports: winston.transport[] = [];

  // Console output
  if (enableConsole) {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
          })
        ),
      })
    );
  }

  // File output - all logs, and errors only. Skipped entirely when the caller
  // says something else owns these paths (see LoggerConfig.file).
  if (enableFiles) {
    transports.push(
      new winston.transports.File({
        filename: mainLogFile,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      })
    );

    transports.push(
      new winston.transports.File({
        filename: errLogFile,
        level: 'error',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      })
    );
  }

  // Make a failing transport visible. This is NOT what fixes BUG-037 - winston
  // already swallows an unopenable file without throwing (verified by removing
  // this loop and watching the test still pass). It is here because a transport
  // that quietly cannot write is exactly what went unnoticed for 12 days: with
  // no handler there is nothing anywhere saying the file is unwritable.
  for (const transport of transports) {
    transport.on('error', (error: Error) => {
      process.stderr.write(
        `logger transport failed (${transport.constructor.name}), continuing ` +
          `without it: ${error.message}\n`
      );
    });
  }

  const winstonLogger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        return log;
      })
    ),
    transports,
  });

  // Return Logger interface implementation
  return {
    info(message: string, ...args: any[]): void {
      if (args.length > 0) {
        winstonLogger.info(message, args[0]);
      } else {
        winstonLogger.info(message);
      }
    },
    warn(message: string, ...args: any[]): void {
      if (args.length > 0) {
        winstonLogger.warn(message, args[0]);
      } else {
        winstonLogger.warn(message);
      }
    },
    error(message: string, ...args: any[]): void {
      if (args.length > 0) {
        winstonLogger.error(message, args[0]);
      } else {
        winstonLogger.error(message);
      }
    },
    debug(message: string, ...args: any[]): void {
      if (args.length > 0) {
        winstonLogger.debug(message, args[0]);
      } else {
        winstonLogger.debug(message);
      }
    },
  };
}

/**
 * Create a simple console-only logger (for testing)
 */
export function createConsoleLogger(botId: string): Logger {
  return {
    info(message: string, ...args: any[]): void {
      console.log(`[${botId}] INFO: ${message}`, ...args);
    },
    warn(message: string, ...args: any[]): void {
      console.warn(`[${botId}] WARN: ${message}`, ...args);
    },
    error(message: string, ...args: any[]): void {
      console.error(`[${botId}] ERROR: ${message}`, ...args);
    },
    debug(message: string, ...args: any[]): void {
      console.debug(`[${botId}] DEBUG: ${message}`, ...args);
    },
  };
}

/**
 * Create a null logger (for testing - does nothing)
 */
export function createNullLogger(): Logger {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
    debug(): void {},
  };
}
