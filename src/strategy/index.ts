/**
 * Strategy Module
 *
 * Exports signal detection and position management functions.
 */

// Signal detection
export {
  detectMFICrossSignal,
  generateSignal,
  isValidSignal,
} from './signals';

// Position management
export {
  createTwoLegPosition,
  updatePositions,
  getOpenLegs,
  getClosedLegs,
  getRetiredLegs,
  graduateLeg,
  retireLeg,
  closeRunnersOnTrimSignal,
  calculateUnrealizedPnL,
  calculateRealizedPnL,
  getPositionSummary,
} from './position';
