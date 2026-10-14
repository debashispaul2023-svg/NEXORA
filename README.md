# NEXORA / FabInvests Starter

<p align="center">
  <img src="assets/branding/nexora-bot.png" alt="NEXORA bot — quantitative research, paper trading, AI learning" width="320" />
</p>

This starter pack provides repository guardrails and project memory files so an AI coding agent can keep track of the project, paths, phase, and decisions.

## First steps
1. Put this folder at the intended project location.
2. Open this folder as the project/repository in your coding environment.
3. Make sure `AGENTS.md` is visible to the agent.
4. Ask the agent to read `AGENTS.md`, `PROJECT_MAP.md`, `CURRENT_STATE.md`, and `DECISIONS.md` before acting.
5. Start with Phase 0 analysis only. Do not allow implementation until you approve it.

## Important
This is a context-and-safety scaffold, not the complete FabInvests application. It intentionally contains no trading engine and no exchange integration.

## Root path rule
The repository root is the directory containing this README and `AGENTS.md`. The agent must verify the actual absolute path in its environment rather than inventing one.

## Phase 1 — Setup and operation

### Requirements
- Node.js >= 18 (ES modules + `import.meta.url`)

### Setup
```bash
# Optional: copy example env (no real secrets)
cp .env.example .env

# No external dependencies required for Phase 1 foundation
```

### Available commands
```bash
npm start          # Run foundation entry point (loads config, inits data dirs, health check)
npm run check      # Validation-only mode (--check)
npm run init-data  # Explicit data-directory initialization
npm test           # Run all tests (node:test, serial)

# Synthetic research (paper only; not a profitability claim)
node src/index.mjs --backtest
node src/index.mjs --walk-forward
node src/index.mjs --backtest --count=40 --capital=1000
node src/index.mjs --walk-forward --count=40 --warmup-bars=5 --eval-bars=10 --step-bars=10

# Optional daily equity data (not real-time). Requires FABINVESTS_ALPHAVANTAGE_KEY.
# Synthetic remains the default. No network call unless --provider is set.
node src/index.mjs --backtest --provider=alphavantage --symbol=IBM
```

### Configuration
- Defaults: `config/config.example.json`
- Overrides: environment variables prefixed `FABINVESTS_` (see `.env.example`)
- Minimal built-in `.env` loader (no external dotenv dependency)
- Paper-trading mode is enforced and cannot be overridden

### Phase 2 — Market data (synthetic only)
- Candle validation and series checks live in `src/market-data/candle.mjs`.
- Deterministic synthetic fixtures: `src/market-data/fixtures.mjs` (always labeled `source: synthetic`).
- Indicators (SMA, EMA, RSI): `src/market-data/indicators.mjs` — causal only, null during warm-up.
- No live provider is integrated. Do not treat synthetic data as real market data.

### Phase 3 — Paper execution and accounting (in-memory)
- Supported order type: **MARKET only**. Partial fills, limit, stop, short selling, leverage, margin, and liquidation are not supported.
- Fill model: first candle with timestamp >= order timestamp; fill price = that candle's close adjusted by configurable slippage (bps). Never uses later candles.
- Accounting: integer-cent cash, long-only positions, average entry, realized/unrealized P&L, fees, equity. Invariants prevent negative cash or position.
- State is in-memory only. Restart recovery is not implemented.
- Synthetic fills are not real market execution guarantees.

### Phase 4 — Local durable persistence and recovery
- Snapshots written to `data/trades/paper-state.json` (version 1).
- Atomic write: temp file + fsync + rename; previous snapshot kept as `.bak`.
- Recovery loads latest valid snapshot, falls back to backup, validates cash/position invariants, restores order idempotency.
- Authoritative: cash, position, average entry, realized P&L, ledger, processed fill ids, orders.
- Derived (not stored): equity, unrealized P&L.
- Reserved `trainingCheckpoint` field exists; no Training Engine is implemented.
- Restart recovery works only after a successful prior save.

### Phase 5 — Risk Management Engine
- Public path: `PaperTradingWorkflow.submitOrder` (validate → risk → execute → account → persist).
- Defaults: maxPositionQty=10, maxPositionNotional=500, maxOrderNotional=200, dailyRealizedLossLimit=50.
- Set a limit to `null` to disable it explicitly.
- Trading day = UTC calendar date. Daily realized-loss state is persisted and survives restart.
- Daily realized-loss limit ≠ maximum drawdown limit.
- Rejections do not modify cash, position, or ledger.
- Fail-closed: risk evaluation errors reject the order.
- Long-only. No short selling, leverage, margin, or liquidation.

### Phase 5.1 — Transaction consistency
- Workflow captures pre-state before accounting changes.
- If persistence fails, in-memory ledger, daily tracker, and engine are rolled back to the pre-state.
- Result includes `durable: true/false` and an `outcome` string (`committed`, `rolled_back`, `memory_only`, etc.).
- Ambiguous write errors are resolved by checking whether the new state appears on disk.
- Retry after rollback is safe; the same order id cannot create duplicate fills.
- Limitation: this guarantees same-process consistency with the last successful snapshot, not perfect crash atomicity across all failure modes.

### Phase 6 — Strategy Signal Interface
- Strategy contract: stable ID, version, signal (BUY/SELL/HOLD), reason, indicator values.
- Baseline: `baseline-sma-ema-rsi` v1.0.0 — SMA(5), EMA(5), RSI(14).
- Insufficient history → HOLD (not actionable).
- HOLD produces no order. Actionable signals become order intents submitted only through `PaperTradingWorkflow.submitOrder`.
- Order id = `strategyId-timestamp` (idempotent on repeated evaluation).
- Evaluation records capture signal, indicators, risk decision, and outcome. Not a learning system.
- Signals do not guarantee profit and are not claims about future prices.

### Phase 7 — Persistent records and performance analytics
- Evaluation store: `data/episodes/evaluations.json` (schema v1).
- Deduplication key: `strategyId:candleTimestamp` (duplicates ignored; history not overwritten).
- Metrics: total/actionable signals, submitted/accepted/rejected orders, completed trades, win rate, realized/unrealized P&L, fees, equity, max drawdown.
- Open positions are excluded from completed win/loss counts.
- Optional directional scoring with a fixed candle horizon; unresolved predictions counted separately.
- Directional accuracy is not trade profitability. No automatic learning.

### Phase 8 — Event and equity audit trail
- Events: `data/audit/events.jsonl` (schema v1). Types include SIGNAL_RECORDED, ORDER_SUBMITTED, ORDER_REJECTED, ORDER_APPROVED, ORDER_FILLED, ACCOUNTING_APPLIED, EQUITY_SNAPSHOT_RECORDED, RECOVERY_COMPLETED, RECOVERY_FAILED.
- Equity snapshots: `data/audit/equity.jsonl`. Formula: mark-to-market = cash + positionQty × markPrice when mark available; otherwise cash-only (explicitly labeled).
- Duplicate eventId / snapshotId rejected. Malformed lines skipped and counted. History never truncated.
- `reconcileAudit()` is read-only. Audit log does not replace the accounting ledger.
- Not tamper-proof. Single-writer. Multi-file atomicity not guaranteed.
- No secrets stored. No live data. No learning.

### Phase 9 — Audit integration
- `PaperTradingWorkflow.submitOrder` emits lifecycle events automatically: ORDER_SUBMITTED → ORDER_APPROVED or ORDER_REJECTED → ORDER_FILLED → ACCOUNTING_APPLIED → EQUITY_SNAPSHOT_RECORDED.
- Correlation ID = order id.
- ORDER_FILLED is emitted only after the execution engine confirms a fill. ACCOUNTING_APPLIED only after accounting succeeds.
- Audit write failure after a committed trade reports `auditDegraded: true` and does not roll back accounting.
- Portfolio persistence failure still rolls back in-memory state (Phase 5.1) and emits a rejection event.
- Equity snapshot uses provided `markPrice` (mark-to-market) or records cash-only when no mark is available.
- StrategyRunner emits SIGNAL_RECORDED. HOLD produces no order.
- Tests run serially to honor the single-writer audit requirement.

### Phase 9.1 — Remediation
- Process-local lock serializes `submitOrder` and JSONL appends within one process. Not multi-process safe.
- Rejection stages are explicit: `risk`, `execution`, `accounting`. Post-accounting rollback emits `TRANSACTION_ROLLED_BACK`, not `ORDER_REJECTED`.
- Audit write failure after a committed trade reports `auditDegraded` and does not roll back accounting.
- Strategy-level realized P&L is `null` (shared aggregate position; no allocation model). Portfolio-level realized P&L remains authoritative.
- Intermittent `EIO` on append is an environmental filesystem limitation; mitigated by retry, not eliminated.

### Phase 10 — Historical backtesting
- `BacktestEngine` processes candles chronologically. At index i the strategy sees only `candles[0..i]`.
- Fill model matches the existing engine: order timestamp = candle i timestamp; fill at the close of the first candle with timestamp >= order timestamp, adjusted by slippage. Never uses future highs or lows.
- Each run uses fresh engine, ledger, and workflow state and a unique `runId`.
- Metrics: starting capital, ending cash, ending position, ending equity (mark-to-market when a final mark exists, otherwise cash-only), realized P&L, unrealized when a mark exists, fees, completed SELL exits, win rate, max drawdown. `strategyRealizedPnl` is always null.
- Run records are stored under `data/backtests/` and are never overwritten.
- Synthetic test results do not imply profitability.

### Phases 13–16 — Walk-forward, metrics quality, dataset report
- Walk-forward: fixed-parameter chronological windows, independent capital, no parameter fitting.
- `aggregatePnl` is unavailable across independent windows. Positive window counts are not robustness.
- `buildDatasetReport` produces errors/warnings/info; `TIME_GAP` only when `expectedIntervalMs` is set.
- Successful backtest and walk-forward results include additive `datasetReport`. Schema version remains 1.

### Phase 17 — Research CLI
- `src/research/cli.mjs` drives synthetic backtest/walk-forward via existing engines (no duplicated logic).
- Flags: `--backtest`, `--walk-forward`, optional `--count`, `--capital`, window sizes, `--expected-interval-ms`.
- Output is structured logs. Synthetic only. Not a claim of future performance.

### Phase 18 — Alpha Vantage daily adapter
- Read-only `TIME_SERIES_DAILY` (compact). Not real-time.
- Opt-in: `--provider=alphavantage --symbol=IBM`. Synthetic remains default.
- Key from `FABINVESTS_ALPHAVANTAGE_KEY`. Missing key fails closed.
- Local cache under `data/market/` with provenance and 24-hour default freshness.
- Free tier: 25 requests/day. Unlimited educational tier is not claimed.

### Phase 19 — Paper integration
- `src/paper/session.mjs` passes validated candles into the existing paper workflow.
- Invalid candles and stale provider cache are rejected before any mutation.
- Duplicate candle identity (`provider:symbol:timestamp`) is skipped.
- Opt-in: `node src/index.mjs --paper`. Synthetic remains separate from provider-backed runs.
- No live exchange orders. No AI learning.

### Phase 20 — Experiment foundation
- Local registry under `data/experiments/` (gitignored runtime data).
- Storage: temp + fsync + rename with `.bak` rotation. Malformed registry throws; never silently emptied.
- Same-process write serialization; multi-process writers are not supported.
- Config fingerprints are stable under object key reordering.
- Evaluation reuses `BacktestEngine` and walk-forward. Invalid series fail closed. No fill or accounting changes.
- Learning records require a completed experiment; one record per experiment (idempotent); provisional when sample insufficient.
- Promotion requires completion, dataset quality, sample size, out-of-sample (walk-forward), and finite drawdown evidence where required. Missing evidence blocks. `liveTradingEnabled` is always false.
- No external AI model is required.

### Safety
- Paper trading only. No real orders or credentials.
- All paths resolved from verified project root and canonicalized with realpathSync (resists symlink escapes where creation is permitted).
- Non-existent targets are supported by canonicalizing the existing parent.
- Secrets are redacted from logs.
- Safety flags cannot be overridden by environment variables.


