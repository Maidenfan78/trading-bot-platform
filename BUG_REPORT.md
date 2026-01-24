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

## 5) Command injection in systemctl service - OPEN

**Severity:** High
**Location:** `src/dashboard/services/systemctl.ts:20,50,59,68,77,87,135`
**Impact:** `serviceName` parameter is passed directly into shell commands via `execAsync()`. An attacker controlling bot names could inject shell metacharacters (e.g., `; rm -rf /` or `| cat /etc/passwd`) to execute arbitrary commands.

**Risky Code:**

```typescript
await execAsync(`systemctl show ${serviceName} --property=...`);
await execAsync(`sudo systemctl start ${serviceName}`);
```

**Suggested Fix:**

- Whitelist valid service names with regex: `/^[a-zA-Z0-9_@-]+$/`
- Or use spawn with array args: `spawn('systemctl', ['show', serviceName, ...])`

---

## 6) Path traversal in CSV directory deletion - OPEN

**Severity:** Medium
**Location:** `src/dashboard/createDashboardApp.ts:355`
**Impact:** `bot.csvDir` from loaded JSON is concatenated with `config.csvDir`. If `bot.csvDir` contains `../../../`, attackers could delete arbitrary directories outside the intended scope.

**Risky Code:**

```typescript
await fs.rm(path.join(config.csvDir, bot.csvDir), { force: true, recursive: true });
```

**Suggested Fix:**

```typescript
if (bot.csvDir.includes('..') || path.isAbsolute(bot.csvDir)) {
  throw new Error('Invalid csvDir path');
}
```

---

## 7) Division by zero in quote validation - OPEN

**Severity:** Medium
**Location:** `src/solana/jupiter.ts:261-271`
**Impact:** If Jupiter API returns `outAmount: "0"`, the degradation percentage calculation divides by zero, causing `Infinity` or crash.

**Risky Code:**

```typescript
const originalOut = parseInt(originalQuote.outAmount);
const freshOut = parseInt(freshQuote.outAmount);
const degradationPct = ((originalOut - freshOut) / originalOut) * 100;
```

**Suggested Fix:**

```typescript
if (originalOut === 0) return false;
```

---

## 8) Missing bounds checking on query parameters - OPEN

**Severity:** Medium
**Location:** `src/dashboard/createDashboardApp.ts:510-511,615,792-793,834`
**Impact:** No bounds checking on `limit`, `offset`, `lines` params. Attacker can request `limit=999999999` causing memory exhaustion.

**Risky Code:**

```typescript
const limit = parseInt(req.query.limit as string) || 50;
const lines = parseInt(req.query.lines as string) || 100;
```

**Suggested Fix:**

```typescript
const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 1000));
```

---

## 9) Insufficient wallet secret key validation - OPEN

**Severity:** Medium
**Location:** `src/solana/wallet.ts:23-36`
**Impact:** Accepts any base58 string without length validation. Solana secret keys must be exactly 64 bytes. Could silently accept truncated or padded keys.

**Risky Code:**

```typescript
const secretKeyBytes = bs58.decode(secretKey);
const keypair = Keypair.fromSecretKey(secretKeyBytes);
```

**Suggested Fix:**

```typescript
if (secretKeyBytes.length !== 64) {
  throw new Error('Secret key must be exactly 64 bytes');
}
```

---

## 10) Floating point precision in financial calculations - OPEN

**Severity:** Medium
**Location:** `src/execution/LiveBroker.ts:175-176,310-312`, `src/execution/PaperBroker.ts:71`
**Impact:** Bitcoin and PnL math uses native JavaScript floating point, which accumulates rounding errors. For trading, this can cause incorrect position sizing and P&L reporting.

**Risky Code:**

```typescript
const btcBought = Number(quote.outAmount) / 1e8;
const pnl = (avgExitPrice - leg.entryPrice) * leg.quantity;
```

**Suggested Fix:**

- Use `decimal.js` or `big.js` for all financial calculations
- Or convert to integer math (satoshis/lamports) throughout

---

## 11) Race condition in StateManager file writes - OPEN

**Severity:** Medium
**Location:** `src/core/StateManager.ts:66-73`
**Impact:** If two StateManager instances write simultaneously to the same file, one could lose data. No file locking mechanism exists.

**Risky Code:**

```typescript
const tempPath = `${this.filePath}.tmp`;
fs.writeFileSync(tempPath, content, 'utf-8');
fs.renameSync(tempPath, this.filePath);
```

**Suggested Fix:**

- Add file locking with `proper-lockfile` package
- Or use async versions with exclusive file open flags

---

## 12) Missing CSRF protection on dashboard endpoints - OPEN

**Severity:** Low
**Location:** `src/dashboard/createDashboardApp.ts:225-245`
**Impact:** POST endpoints (login, bot actions) have no CSRF token validation. An attacker's website could trigger bot actions if user is authenticated.

**Suggested Fix:**

- Add `csurf` middleware for CSRF protection

---

## 13) No Content Security Policy headers - OPEN

**Severity:** Low
**Location:** `src/dashboard/createDashboardApp.ts:94-98`
**Impact:** Dashboard has no CSP headers, leaving it vulnerable to XSS if any user input is reflected.

**Suggested Fix:**

```typescript
import helmet from 'helmet';
app.use(helmet());
```

---

## 14) Weak JWT secret validation - OPEN

**Severity:** Low
**Location:** `src/dashboard/createDashboardApp.ts:73-74`
**Impact:** Only checks for one placeholder string. Weak secrets like "123456" pass validation.

**Risky Code:**

```typescript
if (!config.jwtSecret || config.jwtSecret.includes('your-secret')) {
  throw new Error('SECURITY: Please provide a proper JWT_SECRET!');
}
```

**Suggested Fix:**

```typescript
if (!config.jwtSecret || config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
```

---

## Notes
- Suggested fixes are minimal and preserve the current architecture.
- No tests currently cover these scenarios; adding targeted unit tests would prevent regressions.
- Issues #5-14 discovered during security code review sweep (2026-01-24).
- Priority: Fix #5 (command injection) immediately, then #6-10 before next production deploy.
