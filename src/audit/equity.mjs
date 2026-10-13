import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { AuditError } from '../errors.mjs';
import { withProcessLock } from './lock.mjs';



/**
 * Chronological equity snapshots (JSONL).
 *
 * Path: data/audit/equity.jsonl
 * Schema version: 1
 *
 * Equity formula (when markPrice is a finite non-negative number):
 *   equity = cash + positionQty * markPrice
 *   unrealizedPnl = (markPrice - avgEntry) * positionQty
 *   mode = 'mark_to_market'
 *
 * When markPrice is unavailable:
 *   equity = cash
 *   unrealizedPnl = null
 *   mode = 'cash_only'
 *
 * Snapshot recording does not mutate the portfolio.
 * Deduplication: snapshotId must be unique. Equal timestamps are allowed
 * if snapshotIds differ; load order is file order (append order).
 *
 * Not tamper-proof. Single-writer. Malformed lines skipped and counted.
 */

export const EQUITY_SCHEMA_VERSION = 1;
export const EQUITY_FILENAME = 'equity.jsonl';

function equityPath() {
  return resolveProjectPath(join('data', 'audit', EQUITY_FILENAME));
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Build an equity snapshot from a ledger snapshot (and optional mark).
 * Does not mutate the ledger.
 * @param {object} ledgerSnapshot - from AccountingLedger.snapshot()
 * @param {object} [opts]
 * @returns {object}
 */
export function buildEquitySnapshot(ledgerSnapshot, opts = {}) {
  if (!ledgerSnapshot || typeof ledgerSnapshot !== 'object') {
    throw new AuditError('ledgerSnapshot is required');
  }
  const cash = Number(ledgerSnapshot.cash);
  const positionQty = Number(ledgerSnapshot.positionQty);
  const avgEntry = Number(ledgerSnapshot.avgEntry);
  const realizedPnl = Number(ledgerSnapshot.realizedPnl);
  const initialCapital = Number(ledgerSnapshot.initialCapital);

  if (!Number.isFinite(cash) || !Number.isFinite(positionQty)) {
    throw new AuditError('cash and positionQty must be finite');
  }

  const markPrice = opts.markPrice;
  const hasMark = Number.isFinite(markPrice) && markPrice >= 0;

  let equity;
  let unrealizedPnl = null;
  let mode;
  if (hasMark) {
    equity = cash + positionQty * markPrice;
    unrealizedPnl = (markPrice - (Number.isFinite(avgEntry) ? avgEntry : 0)) * positionQty;
    mode = 'mark_to_market';
  } else {
    equity = cash;
    mode = 'cash_only';
  }

  return {
    schemaVersion: EQUITY_SCHEMA_VERSION,
    snapshotId: opts.snapshotId || `eq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    timestamp: Number.isFinite(opts.timestamp) ? Math.floor(opts.timestamp) : Date.now(),
    initialCapital: Number.isFinite(initialCapital) ? initialCapital : null,
    cash,
    positionQty,
    avgEntry: Number.isFinite(avgEntry) ? avgEntry : null,
    realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : null,
    unrealizedPnl,
    equity,
    cumulativeFees: Number.isFinite(opts.cumulativeFees) ? opts.cumulativeFees : null,
    markPrice: hasMark ? markPrice : null,
    markSource: hasMark ? (opts.markSource || 'provided') : null,
    mode,
  };
}

export function validateEquitySnapshot(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new AuditError('Equity snapshot must be an object');
  }
  if (snap.schemaVersion !== EQUITY_SCHEMA_VERSION) {
    throw new AuditError(`Unsupported equity schema version: ${snap.schemaVersion}`);
  }
  if (typeof snap.snapshotId !== 'string' || !snap.snapshotId) {
    throw new AuditError('snapshotId is required');
  }
  if (!Number.isFinite(snap.timestamp)) {
    throw new AuditError('timestamp must be finite');
  }
  if (!Number.isFinite(snap.equity) || !Number.isFinite(snap.cash)) {
    throw new AuditError('equity and cash must be finite');
  }
  if (snap.mode !== 'mark_to_market' && snap.mode !== 'cash_only') {
    throw new AuditError('mode must be mark_to_market or cash_only');
  }
  return snap;
}

/**
 * Append an equity snapshot. Rejects duplicate snapshotId.
 * Serialized within this process. Does not mutate the portfolio.
 */
export async function appendEquitySnapshot(snap) {
  return withProcessLock(() => appendEquityUnlocked(snap));
}

let equityWriter = appendFileSync;

/** Test-only writer override. Pass null to restore appendFileSync. */
export function _setEquityWriterForTests(fn) {
  equityWriter = fn || appendFileSync;
}

function appendEquityUnlocked(snap) {
  const normalized = validateEquitySnapshot(snap);
  const path = equityPath();
  ensureDir(path);

  if (snapshotIdPresent(normalized.snapshotId)) {
    return { appended: false, snapshot: normalized, duplicate: true };
  }

  const line = JSON.stringify(normalized) + '\n';
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      equityWriter(path, line, 'utf8');
      return { appended: true, snapshot: normalized, duplicate: false };
    } catch (err) {
      lastErr = err;
      if (snapshotIdPresent(normalized.snapshotId)) {
        return { appended: true, snapshot: normalized, duplicate: false, landedDespiteError: true };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  throw new AuditError(`Failed to append equity snapshot: ${lastErr.message}`, { code: lastErr.code });
}

function snapshotIdPresent(snapshotId) {
  return loadEquitySnapshots().snapshots.some((s) => s.snapshotId === snapshotId);
}




export function loadEquitySnapshots() {
  const path = equityPath();
  if (!existsSync(path)) {
    return { snapshots: [], malformed: 0, unsupported: 0, fileSize: 0, duplicateSnapshotIds: 0 };
  }
  const raw = readFileSync(path, 'utf8');
  const fileSize = statSync(path).size;
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const snapshots = [];
  const seen = new Set();
  let malformed = 0;
  let unsupported = 0;
  let duplicateSnapshotIds = 0;

  for (const line of lines) {
    if (!line.trim()) {
      malformed += 1;
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj.schemaVersion !== EQUITY_SCHEMA_VERSION) {
      unsupported += 1;
      continue;
    }
    try {
      const snap = validateEquitySnapshot(obj);
      if (seen.has(snap.snapshotId)) {
        duplicateSnapshotIds += 1;
        continue;
      }
      seen.add(snap.snapshotId);
      snapshots.push(snap);
    } catch {
      malformed += 1;
    }
  }

  return { snapshots, malformed, unsupported, fileSize, duplicateSnapshotIds };
}

