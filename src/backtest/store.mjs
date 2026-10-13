import { writeFileSync, existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';

import { join, dirname } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { AuditError } from '../errors.mjs';

/**
 * Backtest run record store.
 *
 * Path: data/backtests/<runId>.json
 * Never overwrites an existing run record.
 * Does not store secrets.
 */

export const BACKTEST_SCHEMA_VERSION = 1;

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
    throw new AuditError('runId must be 1-80 chars of letters, digits, underscore, or hyphen');
  }
}

function runPath(runId) {
  assertSafeRunId(runId);
  return resolveProjectPath(join('data', 'backtests', `${runId}.json`));
}


/**
 * Persist a backtest run record. Rejects if the file already exists.
 * @param {object} result - from BacktestEngine.run
 * @returns {{ saved: boolean, path: string }}
 */
export function saveBacktestRun(result) {
  if (!result || !result.runId) {
    throw new AuditError('Backtest result must include runId');
  }
  const path = runPath(result.runId);
  if (existsSync(path)) {
    throw new AuditError(`Backtest run already exists: ${result.runId}`);
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const record = {
    schemaVersion: BACKTEST_SCHEMA_VERSION,
    ...result,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { saved: true, path };
}


/**
 * Load a previously saved run record.
 * @param {string} runId
 * @returns {object|null}
 */
export function loadBacktestRun(runId) {
  const path = runPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
