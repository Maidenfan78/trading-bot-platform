/**
 * Indicators Module
 *
 * Exports all indicator calculation functions and types.
 */

// Import functions for use in the INDICATORS registry (must be at top)
import {
  typicalPrice,
  calculateMFI,
  calculateMFIWithMetadata,
  calculateMFISeries,
  detectMFICross,
} from './mfi.js';

import {
  calculateTrueRange,
  calculateATR,
  calculateATRWithMetadata,
  calculateATRSeries,
  calculateATRLevels,
  updateTrailingStop,
  isValidATR,
} from './atr.js';

import type {
  TCF2State} from './tcf2.js';
import {
  initTCF2State,
  calculateTCF2Series,
  getTCF2Signal,
  calculateTCF2WithSignal
} from './tcf2.js';

import {
  calculateKPSSSeries,
  getKPSSSignal,
  calculateKPSSWithSignal,
} from './kpss.js';

import {
  calculateTDFISeries,
  getTDFISignal,
  calculateTDFIWithSignal,
} from './tdfi.js';

import {
  calculateDSSMOMSeries,
  getDSSMOMSignal,
  calculateDSSMOMWithSignal,
} from './dssmom.js';

// Re-export MFI
export {
  typicalPrice,
  calculateMFI,
  calculateMFIWithMetadata,
  calculateMFISeries,
  detectMFICross,
};

// Re-export ATR
export {
  calculateTrueRange,
  calculateATR,
  calculateATRWithMetadata,
  calculateATRSeries,
  calculateATRLevels,
  updateTrailingStop,
  isValidATR,
};

// Re-export TCF2
export {
  initTCF2State,
  calculateTCF2Series,
  getTCF2Signal,
  calculateTCF2WithSignal,
};
export type { TCF2State };

// Re-export KPSS
export {
  calculateKPSSSeries,
  getKPSSSignal,
  calculateKPSSWithSignal,
};

// Re-export TDFI
export {
  calculateTDFISeries,
  getTDFISignal,
  calculateTDFIWithSignal,
};

// Re-export DSS-MOM
export {
  calculateDSSMOMSeries,
  getDSSMOMSignal,
  calculateDSSMOMWithSignal,
};

/**
 * Indicator Registry
 *
 * Maps indicator names to their calculation functions.
 * Useful for dynamic indicator selection.
 */
export const INDICATORS = {
  mfi: {
    name: 'MFI',
    description: 'Money Flow Index - momentum indicator using price and volume',
    calculate: calculateMFISeries,
    detectSignal: detectMFICross,
  },
  tcf2: {
    name: 'TCF2',
    description: 'Trend Continuation Factor 2 - measures trend strength',
    calculate: calculateTCF2Series,
    getSignal: getTCF2Signal,
  },
  kpss: {
    name: 'KPSS',
    description: 'Kase Permission Stochastic Smoothed',
    calculate: calculateKPSSSeries,
    getSignal: getKPSSSignal,
  },
  tdfi: {
    name: 'TDFI',
    description: 'Trend Direction & Force Index',
    calculate: calculateTDFISeries,
    getSignal: getTDFISignal,
  },
  dssmom: {
    name: 'DSS-MOM',
    description: 'DSS Averages of Momentum',
    calculate: calculateDSSMOMSeries,
    getSignal: getDSSMOMSignal,
  },
} as const;

export type IndicatorName = keyof typeof INDICATORS;
