# Security notes — NEXORA

## Architecture
NEXORA is a local, single-process, zero-dependency paper-trading simulator.
It has no HTTP server, no database, no authentication system, and no live exchange integration.

## Trust boundary
The process owner is trusted. Inputs are local configuration, local candle fixtures, and local snapshot/audit files. Path resolution is confined to the project root.

## Controls in place
- Paper-trading mode is enforced; real orders are rejected by config validation.
- `resolveProjectPath` rejects absolute paths, `..` traversal, and symlink escapes (symlink resistance is implemented; full verification is environment-dependent).
- Structured logger redacts keys matching secret/password/key/token/credential.
- Persistence uses atomic rename with validation. Multi-file atomicity is not claimed.
- Process-local lock serializes workflow and audit writes within one process. Multi-process safety is not claimed.
- Backtest `runId` is restricted to a safe identifier pattern.
- Snapshot and backtest record files are written with owner-only permissions where the platform allows.

## Not applicable
- HTTP security headers, CORS, rate limiting, and API authentication (no HTTP server).
- Password hashing and database access control (no passwords, no database).
- Dependency vulnerability scanning against a lockfile (zero dependencies).

## Remaining limitations
- Process-local locking does not protect against other processes writing the same files.
- Audit JSONL is append-oriented and not tamper-proof.
- Symlink escape test may skip in environments that return EPERM.
- Logger redacts sensitive key names, not arbitrary secret-looking values in free text.
