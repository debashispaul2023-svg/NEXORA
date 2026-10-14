# Current State — Update After Every Approved Phase

## Current status
- Phase: 20 — Strategy experiment tracking and learning foundation (hardened)
- Implementation status: Registry, evaluation, learning records, and promotion gate hardened; tests expanded.
- Last verified repository root: /home/workdir/artifacts/NEXORA_FabInvests_Starter
- Last verified commit: 39d962e2014dc498db1c1717f2cee5d5581ac8f7 (Phase 19; Phase 20 uncommitted)
- Tests (this session): experiments 13/13 pass; full suite 203/203 pass
- Smoke: --check, --backtest --count=20, walk-forward, --paper --count=12 all exit 0
- Deployment: NOT CONFIGURED

## Current objective
Phase 20 hardening complete pending commit approval. Do not start Phase 21.

## Approved decisions
- Paper trading only
- Phase 1–19: foundation through paper session
- Phase 20: experiment tracking and research-only promotion gate

## Known limitations
- End-of-bar fill model. Strategy-level P&L unavailable. aggregatePnl unavailable.
- Multi-process experiment writers are unsupported. Exactly-once across crashes is not claimed.
- Registry durability matches snapshot class (tmp+fsync+rename); environmental EIO may still surface after bounded retry.
- Learning records are evidence notes, not a trained model.
- Promotion never enables live trading; missing metrics block promotion.
- Synthetic results do not imply profitability.
- Alpha Vantage free tier is 25 requests/day. Compact daily history only. Not real-time.
- Symlink escape test may skip under EPERM in some environments.

## Next approved action
Commit Phase 20 only after explicit approval. Do not push or start Phase 21 without approval.
