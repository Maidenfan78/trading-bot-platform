# Bug Report: trading-bot-platform

## Summary
Multiple logic issues affect live trading safety, multi-asset limits, and paper-trade PnL accuracy.

---

## 1) LiveBroker closes wrong mint (cbBTC vs WBTC) - FIXED
**Severity:** High 
**Location:** `src/execution/LiveBroker.ts` 
**Impact:** If a position was opened with WBTC (cbBTC quote failed), close logic still picks `cbBtcMint`, which can fail balance checks and quote the wrong mint. Positions may become uncloseable.

**Repro (conceptual):**
1. Configure both `cbBtcMint` and `wbtcMint`.
2. Force cbBTC quote failure to open via WBTC.
3. Call `closeLeg` — it uses cbBTC mint unconditionally.

**Fix Applied:**
- Persisted the mint used for each opened position on `PositionLeg.btcMint`.
- `closeLeg` now uses the stored mint (with config fallback).

---

## 2) Position limit checks count legs, not positions - FIXED
**Severity:** Medium 
**Location:** `src/multi-asset/MultiAssetManager.ts` 
**Impact:** `maxPositionsPerAsset`/`maxTotalPositions` are enforced by counting legs. A single 2-leg position counts as 2, halving capacity and blocking trades unexpectedly.

**Repro (conceptual):**
1. Open one two-leg position for an asset.
2. Configure `maxPositionsPerAsset = 1`.
3. `getOpenLegs()` returns 2, blocking any new position despite only one position open.

**Fix Applied:**
- Added a shared `positionId` to legs and count unique open positions per asset (with entry-time fallback for legacy legs).

---

## 3) PaperBroker closes at candle close, not trigger price - FIXED
**Severity:** Medium 
**Location:** `src/execution/PaperBroker.ts` 
**Impact:** `updatePositions` marks legs closed at TP/stop price, but `closeLeg` always uses `candle.close`. This skews PnL and can contradict the logged close reason/price.

**Repro (conceptual):**
1. TP is hit intra-candle.
2. `updatePositions` sets `closePrice` to target price.
3. `closeLeg` still uses `candle.close` for execution.

**Fix Applied:**
- `closeLeg` now uses `leg.closePrice` when present (falls back to `candle.close`) before applying slippage.

---

## 4) BTC decimals hardcoded for specific mints - FIXED
**Severity:** Low 
**Location:** `src/solana/balances.ts` 
**Impact:** If a different BTC mint is configured, balance decimals can be wrong, leading to incorrect balance checks and risk decisions.

**Fix Applied:**
- Fetch and cache mint decimals from chain, with a fallback to defaults if lookup fails.

---

## Notes
- Suggested fixes are minimal and preserve the current architecture.
- No tests currently cover these scenarios; adding targeted unit tests would prevent regressions.
