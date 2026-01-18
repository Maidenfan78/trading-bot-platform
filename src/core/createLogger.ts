import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { Logger } from '../types';

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

  // File output - all logs
  transports.push(
    new winston.transports.File({
      filename: mainLogFile,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    })
  );

  // File output - errors only
  transports.push(
    new winston.transports.File({
      filename: errLogFile,
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    })
  );

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
