# Current State — Update After Every Approved Phase

## Current status
- Phase: 17 — Documentation reconciliation + minimal synthetic research CLI
- Implementation status: Research CLI reuses BacktestEngine and runWalkForward. Docs updated through Phase 17.
- Last verified repository root: /home/workdir/artifacts/NEXORA_FabInvests_Starter
- Last verified commit: verify with git log (Phase 16 reported as b149294 locally; may be ahead of origin)
- Tests: run npm test after Phase 17 changes
- Deployment: NOT CONFIGURED

## Current objective
Phase 17 complete when tests pass. Do not start Phase 18 automatically.

## Approved decisions
- Paper trading only
- Phase 1–9.1: foundation through audit remediation
- Phase 10–14: deterministic backtest, validation, walk-forward, metric reliability
- Phase 15–16: dataset quality report (standalone then attached to results)
- Phase 17: docs reconciliation + synthetic research CLI entry points

## Known limitations
- End-of-bar fill model (signal and fill on candle t close). Not next-bar-open.
- Strategy-level P&L unavailable. aggregatePnl is unavailable for independent windows.
- Multi-process safety not claimed. Exactly-once writes not claimed.
- Synthetic results do not imply profitability.
- No live data, no learning, no cloud.
- TIME_GAP is a warning only when expectedIntervalMs is supplied. No session calendar.
- Symlink escape test remains NOT VERIFIED (EPERM).

## Next approved action
Verify Phase 17 tests. Do not push or start Phase 18 without approval.
