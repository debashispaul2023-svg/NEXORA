import { writeFileSync, renameSync, unlinkSync, existsSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { AnalyticsError, PersistenceError } from '../errors.mjs';

/**
 * Persistent strategy evaluation records (append-only with deduplication).
 *
 * Schema version 1.
 * Deduplication key: strategyId:candleTimestamp
 * Storage: data/episodes/evaluations.json (versioned object with records array)
 *
 * Historical records are never silently overwritten. Duplicate keys are ignored
 * on append (existing record is kept). Unsupported schema versions are rejected.
 * Corrupt files fall back to .bak when available.
 *
 * This is evidence collection only. No learning or strategy evolution.
 */

export const EVAL_SCHEMA_VERSION = 1;
export const EVAL_FILENAME = 'evaluations.json';
export const EVAL_BAK = 'evaluations.json.bak';
export const EVAL_TMP = 'evaluations.json.tmp';

function dataPath(name) {
  return resolveProjectPath(join('data', 'episodes', name));
}

/**
 * Deduplication key for an evaluation.
 * @param {object} rec
 * @returns {string}
 */
export function evaluationKey(rec) {
  if (!rec?.strategyId || rec.candleTimestamp == null) {
    throw new AnalyticsError('Cannot form evaluation key: missing strategyId or candleTimestamp');
  }
  return `${rec.strategyId}:${rec.candleTimestamp}`;
}

/**
 * Validate a single evaluation record.
 * @param {object} rec
 * @returns {object} normalized record
 */
export function validateEvaluationRecord(rec) {
  if (!rec || typeof rec !== 'object') {
    throw new AnalyticsError('Evaluation record must be an object');
  }
  if (typeof rec.strategyId !== 'string' || !rec.strategyId) {
    throw new AnalyticsError('strategyId is required');
  }
  if (typeof rec.strategyVersion !== 'string') {
    throw new AnalyticsError('strategyVersion is required');
  }
  if (!Number.isFinite(rec.timestamp)) {
    throw new AnalyticsError('timestamp must be a finite number (UTC ms)');
  }
  if (!Number.isFinite(rec.candleTimestamp)) {
    throw new AnalyticsError('candleTimestamp must be a finite number');
  }
  if (!['BUY', 'SELL', 'HOLD'].includes(rec.signal)) {
    throw new AnalyticsError(`Invalid signal: ${rec.signal}`);
  }
  if (typeof rec.reason !== 'string') {
    throw new AnalyticsError('reason is required');
  }

  return {
    id: rec.id || evaluationKey(rec),
    schemaVersion: EVAL_SCHEMA_VERSION,
    strategyId: rec.strategyId,
    strategyVersion: rec.strategyVersion,
    timestamp: Math.floor(rec.timestamp),
    candleTimestamp: Math.floor(rec.candleTimestamp),
    signal: rec.signal,
    reason: rec.reason,
    indicators: rec.indicators || {},
    orderId: rec.orderId || null,
    riskDecision: rec.riskDecision || null,
    executionOutcome: rec.executionOutcome || null,
    fillId: rec.fillId || null,
    recordedAt: rec.recordedAt || new Date().toISOString(),
  };
}

function validateStore(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new AnalyticsError('Evaluations store is not an object');
  }
  if (obj.schemaVersion !== EVAL_SCHEMA_VERSION) {
    throw new AnalyticsError(`Unsupported evaluations schema version: ${obj.schemaVersion}`);
  }
  if (!Array.isArray(obj.records)) {
    throw new AnalyticsError('records must be an array');
  }
  return true;
}

function emptyStore() {
  return { schemaVersion: EVAL_SCHEMA_VERSION, updatedAt: new Date().toISOString(), records: [] };
}

/**
 * Load evaluation store from disk.
 * @returns {{ schemaVersion: number, records: object[], updatedAt?: string }}
 */
export function loadEvaluations() {
  const current = dataPath(EVAL_FILENAME);
  const bak = dataPath(EVAL_BAK);
  for (const p of [current, bak]) {
    if (!existsSync(p)) continue;
    try {
      const obj = JSON.parse(readFileSync(p, 'utf8'));
      validateStore(obj);
      // Validate each record; skip corrupt ones with warning count
      const valid = [];
      let corrupt = 0;
      for (const r of obj.records) {
        try {
          valid.push(validateEvaluationRecord(r));
        } catch {
          corrupt += 1;
        }
      }
      return { schemaVersion: obj.schemaVersion, updatedAt: obj.updatedAt, records: valid, corruptCount: corrupt };
    } catch {
      continue;
    }
  }
  return emptyStore();
}

/**
 * Append a new evaluation record if the dedup key is not already present.
 * @param {object} record
 * @returns {{ appended: boolean, store: object, key: string }}
 */
export function appendEvaluation(record) {
  const normalized = validateEvaluationRecord(record);
  const key = evaluationKey(normalized);
  const store = loadEvaluations();
  const exists = store.records.some((r) => evaluationKey(r) === key);
  if (exists) {
    return { appended: false, store, key };
  }

  store.records.push(normalized);
  store.updatedAt = new Date().toISOString();
  saveEvaluationsStore(store);
  return { appended: true, store, key };
}

/**
 * Atomic write of the evaluations store.
 * @param {object} store
 */
export function saveEvaluationsStore(store) {
  validateStore(store);
  for (const r of store.records) {
    validateEvaluationRecord(r);
  }

  const tmp = dataPath(EVAL_TMP);
  const current = dataPath(EVAL_FILENAME);
  const bak = dataPath(EVAL_BAK);
  const json = JSON.stringify(store, null, 2);

  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Validate written content
  validateStore(JSON.parse(readFileSync(tmp, 'utf8')));

  if (existsSync(current)) {
    try {
      renameSync(current, bak);
    } catch {
      try {
        unlinkSync(bak);
        renameSync(current, bak);
      } catch {
        /* ignore */
      }
    }
  }

  let promoted = false;
  for (let attempt = 0; attempt < 3 && !promoted; attempt++) {
    try {
      renameSync(tmp, current);
      promoted = true;
    } catch (err) {
      if (attempt === 2) throw new PersistenceError(`Evaluations rename failed: ${err.message}`, { code: err.code });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
