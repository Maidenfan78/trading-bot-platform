/**
 * Core Module
 *
 * Exports core abstractions for building trading bots.
 */

// Logger
export {
  createLogger,
  createConsoleLogger,
  createNullLogger,
  type LoggerConfig,
} from './createLogger';

// State Management
export { StateManager } from './StateManager';

// Broker Interface & Types
export {
  type Broker,
  type PaperAccount,
  type PaperTradeExecution,
  type PaperBrokerConfig,
  type LiveBrokerConfig,
} from './Broker';
