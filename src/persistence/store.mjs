import { writeFileSync, renameSync, unlinkSync, existsSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { PersistenceError, AccountingError } from '../errors.mjs';
import { AccountingLedger } from '../accounting/ledger.mjs';
import { PaperExecutionEngine } from '../execution/engine.mjs';

/**
 * Versioned local snapshot persistence with atomic writes and recovery.
 *
 * Authoritative fields stored:
 * - cashCents, positionQty, avgEntry, realizedPnlCents, initialCapitalCents, feeBps
 * - ledger entries, processedFills (idempotency)
 * - execution orders map + slippageBps
 *
 * Derived (not stored): unrealized P&L, equity (computed via markToMarket).
 *
 * Atomic write:
 * 1. Write to .tmp in the same directory
 * 2. fsync
 * 3. Validate JSON
 * 4. Rename previous current → .bak (if exists)
 * 5. Rename .tmp → current
 * 6. Clean up
 *
 * Recovery tries current, then .bak. Validates invariants before accepting.
 * In-memory only before first successful save. Restart recovery requires a prior save.
 *
 * Generic checkpoint extension point: snapshot may contain an optional
 * "trainingCheckpoint" object (versioned, opaque). No Training Engine exists;
 * this is only a reserved slot.
 */

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FILENAME = 'paper-state.json';
export const SNAPSHOT_BAK = 'paper-state.json.bak';
export const SNAPSHOT_TMP = 'paper-state.json.tmp';

function dataPath(name) {
  return resolveProjectPath(join('data', 'trades', name));
}

function validateSnapshot(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new PersistenceError('Snapshot is not an object');
  }
  if (obj.version !== SNAPSHOT_VERSION) {
    throw new PersistenceError(`Unsupported snapshot version: ${obj.version}`, { version: obj.version });
  }
  if (!obj.accounting || !obj.execution) {
    throw new PersistenceError('Snapshot missing accounting or execution state');
  }
  if (!Number.isFinite(obj.accounting.cashCents) || obj.accounting.cashCents < 0) {
    throw new PersistenceError('Snapshot cash invariant failed');
  }
  if (!Number.isFinite(obj.accounting.positionQty) || obj.accounting.positionQty < 0) {
    throw new PersistenceError('Snapshot position invariant failed');
  }
  return true;
}

/**
 * Save current engine + ledger state atomically.
 * @param {PaperExecutionEngine} engine
 * @param {AccountingLedger} ledger
 * @param {object} [extra] optional { trainingCheckpoint }
 * @returns {string} path written
 */
export function saveSnapshot(engine, ledger, extra = {}) {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    accounting: ledger.exportState(),
    execution: engine.exportState(),
    trainingCheckpoint: extra.trainingCheckpoint || null, // reserved; no Training Engine
    riskState: extra.riskState || null, // daily loss tracker state
  };

  // Pre-validate
  validateSnapshot(snapshot);

  const tmp = dataPath(SNAPSHOT_TMP);
  const current = dataPath(SNAPSHOT_FILENAME);
  const bak = dataPath(SNAPSHOT_BAK);

  const json = JSON.stringify(snapshot, null, 2);

  // Write temp
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Re-read and validate temp
  const written = JSON.parse(readFileSync(tmp, 'utf8'));
  validateSnapshot(written);

  // Rotate previous
  if (existsSync(current)) {
    try {
      renameSync(current, bak);
    } catch (err) {
      // Best-effort; continue if rename fails (e.g. cross-device, but same dir)
      try { unlinkSync(bak); renameSync(current, bak); } catch { /* ignore */ }
    }
  }

  // Atomic promote (retry once on transient EIO)
  let promoted = false;
  for (let attempt = 0; attempt < 3 && !promoted; attempt++) {
    try {
      renameSync(tmp, current);
      promoted = true;
    } catch (err) {
      if (attempt === 2) throw new PersistenceError(`Atomic rename failed: ${err.message}`, { code: err.code });
      // brief yield
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }


  // Best-effort cleanup of stray tmp
  if (existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }

  return current;
}

/**
 * Load latest valid snapshot into new engine + ledger instances.
 * @returns {{ engine: PaperExecutionEngine, ledger: AccountingLedger, source: string, snapshot: object } | null}
 */
export function loadSnapshot() {
  const current = dataPath(SNAPSHOT_FILENAME);
  const bak = dataPath(SNAPSHOT_BAK);

  const candidates = [
    { path: current, label: 'current' },
    { path: bak, label: 'backup' },
  ];

  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    try {
      const raw = readFileSync(c.path, 'utf8');
      const obj = JSON.parse(raw);
      validateSnapshot(obj);

      const ledger = new AccountingLedger({
        initialCapital: obj.accounting.initialCapitalCents / 100,
        feeBps: obj.accounting.feeBps,
      });
      ledger.importState(obj.accounting);

      const engine = new PaperExecutionEngine({ slippageBps: obj.execution.slippageBps });
      engine.importState(obj.execution);

      // Final invariant check via snapshot
      const snap = ledger.snapshot();
      if (snap.cash < 0 || snap.positionQty < 0) {
        throw new AccountingError('Post-restore invariant failed');
      }

      return { engine, ledger, source: c.label, snapshot: obj, riskState: obj.riskState || null };
    } catch (err) {
      // Try next candidate
      continue;
    }
  }

  return null; // no valid snapshot
}

/**
 * Explicitly reject unsafe paths (used by tests).
 */
export function assertSafeDataPath(rel) {
  return resolveProjectPath(rel); // throws on escape
}
