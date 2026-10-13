# NEXORA Task Protocol

Use this checklist at the start of every task.

## A. Orient
- [ ] Identify current working directory.
- [ ] Verify repository root by locating `AGENTS.md` and `PROJECT_MAP.md`.
- [ ] Read `CURRENT_STATE.md` and relevant decision entries.
- [ ] Check Git status if Git is available.
- [ ] Inspect target files and neighboring modules.

## B. Plan
- [ ] Restate the requested outcome.
- [ ] List exact root-relative file paths to inspect/change.
- [ ] Identify dependencies, configuration, data migrations, and risks.
- [ ] Define acceptance checks.
- [ ] Ask for approval if the phase or scope is not approved.

## C. Execute
- [ ] Change only approved files.
- [ ] Use root-relative paths or path-joining APIs.
- [ ] Do not create duplicate project roots.
- [ ] Do not delete or overwrite unrelated work.
- [ ] Do not expose secrets in logs or generated reports.

## D. Verify
- [ ] Run relevant tests/checks when authorized.
- [ ] Report the exact commands actually run.
- [ ] Distinguish passed, failed, skipped, and not-run checks.
- [ ] Inspect the final diff or changed-file list.

## E. Persist context
- [ ] Update `CURRENT_STATE.md`.
- [ ] Append significant decisions to `DECISIONS.md`.
- [ ] Append a short entry to `CHANGELOG.md`.

If a path, requirement, or existing state is ambiguous, stop and ask rather than guess.
