# Current State — Update After Every Approved Phase

## Current status
- Phase: 18 — Alpha Vantage read-only daily equity adapter
- Implementation status: Provider interface, cache, and CLI opt-in. Synthetic remains default.
- Last verified repository root: /workspace/artifacts/NEXORA_FabInvests_Starter
- Last verified commit: 3cf8503184e0d7ab6e6d459dd8426714c37de73b (Phase 17, local; not pushed)
- Tests: run npm test after Phase 18 changes
- Deployment: NOT CONFIGURED

## Current objective
Phase 18 implementation in progress. Do not start Phase 19.

## Approved decisions
- Paper trading only
- Phase 1–9.1: foundation through audit remediation
- Phase 10–14: deterministic backtest, validation, walk-forward, metric reliability
- Phase 15–16: dataset quality report
- Phase 17: synthetic research CLI
- Phase 18: Alpha Vantage daily adapter (opt-in, not real-time)

## Known limitations
- End-of-bar fill model. Strategy-level P&L unavailable. aggregatePnl unavailable.
- Multi-process safety not claimed. Exactly-once writes not claimed.
- Synthetic results do not imply profitability.
- Alpha Vantage free tier is 25 requests/day. Compact daily history only (~100 points). Full history is premium.
- Unlimited free tier is not claimed.
- Daily data is delayed/historical, not real-time.
- Symlink escape test remains NOT VERIFIED (EPERM).

## Next approved action
Verify Phase 18 tests. Do not push or start Phase 19 without approval.
