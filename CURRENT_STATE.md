# Current State — Update After Every Approved Phase

## Current status
- Phase: 19 — Paper integration of validated market data
- Implementation status: Thin paper session reuses existing workflow. Synthetic remains default.
- Last verified repository root: /workspace/artifacts/NEXORA_FabInvests_Starter
- Last verified commit: 5a879c1d0d1ca6dc50fe2f453e0c6dd314b3b415 (Phase 18, local; not pushed)
- Tests: run npm test after Phase 19 changes
- Deployment: NOT CONFIGURED

## Current objective
Phase 19 implementation in progress. Do not start Phase 20.

## Approved decisions
- Paper trading only
- Phase 1–18: foundation through Alpha Vantage daily adapter
- Phase 19: validated data into existing paper workflow; fail closed on invalid/stale data

## Known limitations
- End-of-bar fill model. Strategy-level P&L unavailable. aggregatePnl unavailable.
- Multi-process safety not claimed. Exactly-once writes not claimed.
- Duplicate protection is same-process / supplied-identity only.
- Synthetic results do not imply profitability.
- Alpha Vantage free tier is 25 requests/day. Compact daily history only. Not real-time.
- Symlink escape test remains NOT VERIFIED (EPERM).

## Next approved action
Verify Phase 19 tests. Do not push or start Phase 20 without approval.
