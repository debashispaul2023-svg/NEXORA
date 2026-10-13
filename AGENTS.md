# NEXORA / FabInvests — Repository Rules

These rules apply to every agent and every task in this repository.

## 1. Repository identity
- Project name: FabInvests
- Agent identity: NEXORA
- Purpose: market-data-driven paper-trading simulator and strategy research platform.
- Trading mode: PAPER TRADING ONLY. Never place real orders or request real trading credentials.

## 2. Never guess the project path
1. Start by identifying the current working directory.
2. Inspect the repository root before changing anything.
3. Treat the directory containing this file as the repository root.
4. Use paths relative to the repository root in plans and reports.
5. Never create a second copy of the project in another directory unless explicitly approved.
6. Never assume a file exists: verify it.
7. Before writing a file, confirm its intended path is inside this repository.
8. If the repository root cannot be identified, STOP and ask for clarification.

## 3. Protect existing work
- Inspect relevant files before editing them.
- Do not overwrite or delete existing files without explaining why and receiving approval.
- Do not run destructive commands, bulk deletion, recursive cleanup, or broad replacement.
- Do not modify unrelated files.
- Do not silently rename directories or change architecture.
- Use small, reviewable changes.
- Keep backups or use version control before risky edits.

## 4. Phase-gated development
- Phase 0 is analysis only.
- Do not code, create files, install packages, or deploy during Phase 0.
- For later phases, explain objectives, files, dependencies, environment variables, risks, and tests before implementation.
- Wait for user approval before beginning a new phase.
- After each phase, report changed files and actual test results.

## 5. Honesty and trading safety
- Never fabricate prices, fills, P&L, fees, funding, news, or test results.
- Clearly label live, cached, stale, simulated, estimated, and unavailable data.
- Risk controls override strategies and learning.
- Preserve losing trades and lifetime statistics; never hide losses.
- No real-money execution, exchange order placement, or real trading credentials.

## 6. Required task workflow
Before any change:
1. Confirm repository root.
2. Read this file and `PROJECT_MAP.md`.
3. Read `CURRENT_STATE.md`.
4. Inspect the exact target files.
5. Explain the intended change and paths.
6. Make only the approved change.
7. Run relevant checks.
8. Update `CURRENT_STATE.md` and `CHANGELOG.md`.

## 7. Path reporting
For every task, state:
- Repository root
- Files read
- Files created/changed
- Commands/tests actually run
- Remaining issues

Never claim a command or test ran unless it actually ran.
