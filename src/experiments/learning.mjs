import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectPath } from '../paths.mjs';
import { getExperiment } from './registry.mjs';

/**
 * Learning records linked to completed experiments.
 * Deterministic evidence only. No external model required.
 *
 * Storage semantics match the experiment registry: temp + fsync + rename.
 * Multi-process writers unsupported. Malformed store throws.
 * Duplicate policy: one record per experimentId (idempotent return of existing).
 */

export const LEARNING_SCHEMA_VERSION = 1;

const LEARNING_FILE = 'learning.json';
const LEARNING_BAK = 'learning.json.bak';
const LEARNING_TMP = 'learning.json.tmp';

let writeDepth = 0;

function withLearningLock(fn) {
  if (writeDepth > 0) {
    throw new Error('Concurrent learning-store write rejected (same-process lock held).');
  }
  writeDepth += 1;
  try {
    return fn();
  } finally {
    writeDepth -= 1;
  }
}

function dirPath() {
  return resolveProjectPath(join('data', 'experiments'));
}

function storePath(name = LEARNING_FILE) {
  return join(dirPath(), name);
}

function emptyStore() {
  return { schemaVersion: LEARNING_SCHEMA_VERSION, records: [] };
}

function validateStore(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Learning store is not an object');
  }
  if (obj.schemaVersion !== LEARNING_SCHEMA_VERSION) {
    throw new Error(`Unsupported learning schema version: ${obj.schemaVersion}`);
  }
  if (!Array.isArray(obj.records)) {
    throw new Error('learning records must be an array');
  }
  return true;
}

function loadStore() {
  const path = storePath();
  if (!existsSync(path)) {
    const bak = storePath(LEARNING_BAK);
    if (existsSync(bak)) {
      const obj = JSON.parse(readFileSync(bak, 'utf8'));
      validateStore(obj);
      return obj;
    }
    return emptyStore();
  }
  const raw = readFileSync(path, 'utf8');
  if (!raw || !raw.trim()) {
    throw new Error('Learning store is empty or truncated');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Learning store JSON is malformed: ${err.message}`);
  }
  validateStore(obj);
  return obj;
}

function atomicSaveStore(store) {
  validateStore(store);
  const dir = dirPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = storePath(LEARNING_TMP);
  const current = storePath(LEARNING_FILE);
  const bak = storePath(LEARNING_BAK);
  const body = JSON.stringify(store, null, 2);

  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  validateStore(JSON.parse(readFileSync(tmp, 'utf8')));

  if (existsSync(current)) {
    try {
      renameSync(current, bak);
    } catch {
      try {
        unlinkSync(bak);
        renameSync(current, bak);
      } catch {
        /* best-effort */
      }
    }
  }

  let promoted = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !promoted; attempt++) {
    try {
      renameSync(tmp, current);
      promoted = true;
    } catch (err) {
      lastErr = err;
      if (attempt === 2) {
        throw new Error(`Learning store rename failed: ${lastErr?.message || err.message}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Create a learning record for a completed experiment.
 * Idempotent: if a record already exists for experimentId, return it.
 */
export function createLearningRecord(experimentId) {
  return withLearningLock(() => {
    const experiment = getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    if (experiment.status !== 'completed') {
      throw new Error('Learning records require a completed experiment');
    }
    if (!experiment.metrics || typeof experiment.metrics !== 'object') {
      throw new Error('Learning records require metrics from a completed evaluation');
    }

    const store = loadStore();
    const existing = store.records.find((r) => r.experimentId === experimentId);
    if (existing) return existing;

    const sample = experiment.metrics.sampleStatus || 'unknown';
    const provisional = sample !== 'adequate_for_description_only' && sample !== 'measured';
    const record = {
      id: randomUUID(),
      schemaVersion: LEARNING_SCHEMA_VERSION,
      experimentId,
      strategyId: experiment.strategyId,
      strategyVersion: experiment.strategyVersion,
      tested: {
        method: experiment.evaluationMethod,
        configFingerprint: experiment.configFingerprint,
        datasetIdentity: experiment.datasetIdentity ?? null,
        dataSource: experiment.dataSource ?? 'unknown',
      },
      observed: experiment.metrics,
      learned: provisional
        ? 'Sample is insufficient or unmeasured. No robust conclusion is claimed.'
        : 'Descriptive metrics were recorded. This is not a claim of future performance.',
      status: provisional ? 'provisional' : 'descriptive',
      nextExperiment: 'Repeat on a held-out window or larger sample before any promotion.',
      createdAt: new Date().toISOString(),
      note: 'Evidence-linked learning record. Not a trained model. Synthetic results do not imply profitability.',
    };

    store.records.push(record);
    atomicSaveStore(store);
    return record;
  });
}

export function listLearningRecords(experimentId = null) {
  const store = loadStore();
  return experimentId
    ? store.records.filter((r) => r.experimentId === experimentId)
    : store.records;
}
