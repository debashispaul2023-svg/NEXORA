# Decision Log

Record material decisions here. Do not silently reverse a decision; propose a change and explain the trade-off first.

## D-001 — Product identity
- Decision: Product is FabInvests; autonomous agent identity is NEXORA.
- Status: Approved by user.

## D-002 — Trading safety
- Decision: Paper trading only; no real order placement or real trading credentials.
- Status: Fixed safety constraint.

## D-003 — Phased implementation
- Decision: Begin with Phase 0 analysis and wait for approval before coding.
- Status: Fixed workflow constraint.

## D-004 — Core stack
- Decision: Node.js ES modules, JavaScript core, JSON/JSONL persistence initially.
- Status: Planned; confirm exact versions during the appropriate phase.

## D-005 — Dashboard
- Decision: Next.js-based dashboard; target port 3002.
- Status: Planned; confirm dependencies and version compatibility before installation.

## D-006 — Phase 1 foundation scope
- Decision: Phase 1 implements only centralized config/validation, safe path utilities, structured logging, error handling, idempotent data-dir init, minimal entry point, and foundation tests. No trading, market-data, strategy, execution, learning, or dashboard code.
- Status: Approved and implemented.

## D-007 — Environment loading
- Decision: Minimal built-in .env parser using Node fs (no external dotenv dependency). process.env takes precedence. .env is gitignored; only .env.example is present. Safety flags cannot be overridden by environment in Phase 1.
- Status: Implemented.

## D-008 — Directory structure reconciliation
- Decision: scripts/lib.mjs and planned src/ subdirectories (market-data, accounting, etc.) are not created in Phase 1. Foundation modules live directly under src/. This preserves the approved long-term architecture without adding unused modules.
- Status: Implemented.

## D-009 — Path hardening (Phase 1.1)
- Decision: Path resolution now uses realpathSync canonicalization on the existing parent (and full path when it exists) to resist symlink-based escapes. Non-existent targets are supported by appending the remainder after the canonical parent. Absolute paths and `..` strings remain rejected. Paper-trading safety controls unchanged.
- Status: Implemented and tested.

## D-010 — loopSeconds source of truth
- Decision: The single source of truth for the default loop interval is `config/config.example.json` (currently 30). Environment variable `FABINVESTS_LOOP_SECONDS` may override it when the value is valid (5–3600). No conflicting 60-second default exists in the repository. Safety flags remain non-overridable.
- Status: Documented.

## D-011 — Phase 2 market-data foundation
- Decision: Phase 2 implements only synthetic-fixture market-data validation and basic causal indicators (SMA, EMA, RSI). No live provider, no network calls, no strategy/execution/risk/learning/UI code. All synthetic data is explicitly labeled. Future storage integrations (R2, Supabase, etc.) remain proposals only.
- Status: Implemented and tested.

## D-012 — Phase 3 paper execution and accounting
- Decision: Phase 3 implements in-memory paper execution (MARKET orders only) and long-only accounting. Fill price = close of first candle with timestamp >= order timestamp, adjusted by configurable slippage. Money tracked in integer cents. Partial fills, short selling, leverage, margin, liquidation, live providers, and durable persistence are explicitly out of scope. Restart recovery is not implemented.
- Status: Implemented and tested.

## D-013 — Phase 4 local durable persistence
- Decision: Phase 4 adds local JSON snapshot persistence under data/trades/ with atomic write (temp + fsync + rename) and .bak fallback. Authoritative state is cash, position, ledger, processed fill ids, and orders. Equity and unrealized P&L are derived. A reserved trainingCheckpoint field exists but no Training Engine is implemented. Recovery validates invariants before accepting state. No cloud storage, no external dependencies.
- Status: Implemented and tested.

## D-014 — Phase 5 risk engine
- Decision: Phase 5 adds a deterministic risk layer. Defaults: maxPositionQty=10, maxPositionNotional=500, maxOrderNotional=200, dailyRealizedLossLimit=50 (currency units). Limits may be set to null to disable explicitly. Trading day is UTC calendar date. Daily realized-loss state is persisted. This is not a drawdown limit. Public workflow is PaperTradingWorkflow.submitOrder; direct engine+ledger calls bypass risk and are unsupported. Fail-closed on risk evaluation errors. Long-only only.
- Status: Implemented and tested.

## D-015 — Phase 5.1 transaction consistency
- Decision: Public workflow captures pre-state, applies accounting and risk updates, then persists. On persistence failure, in-memory state is rolled back to the pre-state so it matches the last known durable snapshot. Outcome is reported explicitly (`durable` flag). Ambiguous failures are resolved by inspecting the on-disk snapshot. Perfect filesystem atomicity across crashes is not claimed.
- Status: Implemented and tested.

## D-016 — Phase 6 strategy signal interface
- Decision: Phase 6 adds a deterministic strategy interface. Baseline strategy `baseline-sma-ema-rsi` v1.0.0 uses SMA(5), EMA(5), RSI(14). BUY/SELL/HOLD only. HOLD and insufficient history produce no order. Actionable signals become order intents submitted exclusively through PaperTradingWorkflow. Order id is strategyId-timestamp. Evaluation records are kept but no learning or evolution is performed. Signals are not claimed to predict future prices.
- Status: Implemented and tested.

## D-017 — Phase 7 persistent evaluations and analytics
- Decision: Evaluation records are stored in data/episodes/evaluations.json (schema v1). Deduplication key is strategyId:candleTimestamp. Historical records are not overwritten. Performance metrics are derived only from evaluation records and the accounting ledger. Win rate uses completed SELL fills only; open positions are excluded. Directional prediction scoring uses a fixed candle horizon and scores only when the target candle is available; HOLD is not scored. No automatic learning or strategy evolution.
- Status: Implemented and tested.

## D-018 — Phase 8 audit trail
- Decision: Local JSONL audit under data/audit/. Event types include SIGNAL_RECORDED, ORDER_SUBMITTED, ORDER_REJECTED, ORDER_APPROVED, ORDER_FILLED, ACCOUNTING_APPLIED, EQUITY_SNAPSHOT_RECORDED, RECOVERY_COMPLETED, RECOVERY_FAILED. Equity formula: mark-to-market when markPrice provided (cash + positionQty * markPrice); otherwise cash-only. Audit is append-oriented, single-writer, not tamper-proof, and does not replace the accounting ledger. Malformed lines are skipped and counted; history is never truncated. Reconciliation is read-only.
- Status: Implemented and tested.

## D-019 — Phase 9 audit integration policy
- Decision: Workflow emits audit events automatically. Correlation ID is the order id. ORDER_FILLED is emitted only after the execution engine confirms a fill. ACCOUNTING_APPLIED only after applyFill succeeds. If audit write fails after accounting has succeeded, the trade remains committed and the result is flagged auditDegraded. Portfolio persistence failure still rolls back in-memory state (Phase 5.1). Equity snapshots are recorded after successful accounting. Multi-file atomicity is not claimed. Tests run serially to honor the single-writer requirement.
- Status: Implemented and tested.

## D-020 — Phase 9.1 remediation
- Decision: Single-process serialization via withProcessLock for submitOrder and JSONL appends. Multi-process safety is not claimed. Rejection semantics are stage-specific. TRANSACTION_ROLLED_BACK is distinct from ORDER_REJECTED. Strategy-level realized P&L is unavailable and reported as null. Intermittent EIO is an environmental filesystem limitation, not a proven application race under serial tests.
- Status: Implemented and tested.

## D-021 — Phase 10 backtest fill and causality
- Decision: Backtests evaluate the strategy only on the chronological prefix candles[0..i]. Order timestamp equals candle i timestamp. Fill uses the existing engine: first candle with timestamp >= order timestamp, fill at that candle's close with slippage. No future highs or lows are used. Each run is isolated with a unique runId. Completed trades are SELL fills that reduced a long position. Strategy-level P&L remains unavailable. Synthetic results do not imply profitability.
- Status: Implemented and tested.

## Pending decisions
- Exact market-data providers and their limits/terms (deferred).
- Cloud backup policy (R2 / Supabase) — deferred.
- Deployment target.
- Non-UTC timezone support for trading-day boundary (currently UTC only).
- Additional strategies or evaluation horizons (deferred).
