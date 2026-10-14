import { createHash, randomUUID } from 'node:crypto';
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
import { resolveProjectPath } from '../paths.mjs';

/**
 * Experiment registry.
 * Local JSON store. Schema version 1.
 * Does not approve strategies or enable trading.
 *
 * Durability (same class as paper snapshots / evaluations):
 * - Write to same-dir temp, fsync, validate JSON, rotate current→.bak, rename tmp→current.
 * - Transient EIO on rename is retried a bounded number of times (max 3).
 * - Multi-process writers are NOT supported. Same-process mutations use a
 *   simple non-reentrant mutex; concurrent same-process writers throw rather
 *   than interleave.
 * - Malformed or unsupported registry data throws; never replaced with empty.
 * - Retry does not claim to eliminate environmental EIO.
 * - Stale cross-process locks are not used (no file lock); multi-process is unsupported.
 */

export const EXPERIMENT_SCHEMA_VERSION = 1;
const STATUSES = new Set(['created', 'running', 'completed', 'failed']);

const REGISTRY_FILE = 'registry.json';
const REGISTRY_BAK = 'registry.json.bak';
const REGISTRY_TMP = 'registry.json.tmp';

/** Same-process non-reentrant mutex. Multi-process not supported. */
let writeDepth = 0;

function withRegistryLock(fn) {
  if (writeDepth > 0) {
    throw new Error(
      'Concurrent experiment registry write rejected (same-process lock held). Multi-process writers are unsupported.',
    );
  }
  writeDepth += 1;
  try {
    return fn();
  } finally {
    writeDepth -= 1;
  }
}

function experimentsDir() {
  return resolveProjectPath(join('data', 'experiments'));
}

function storePath(name = REGISTRY_FILE) {
  return join(experimentsDir(), name);
}

function emptyStore() {
  return { schemaVersion: EXPERIMENT_SCHEMA_VERSION, experiments: [] };
}

function validateStore(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Experiment registry is not an object');
  }
  if (obj.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported experiment schema version: ${obj.schemaVersion}`);
  }
  if (!Array.isArray(obj.experiments)) {
    throw new Error('experiments must be an array');
  }
  return true;
}

/**
 * Try to parse and validate a registry file path.
 * @returns {{ ok: true, store: object } | { ok: false, error: string }}
 */
function tryLoadRegistryFile(path) {
  if (!existsSync(path)) {
    return { ok: false, error: 'missing' };
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `unreadable: ${err.message}` };
  }
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'empty or truncated' };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${err.message}` };
  }
  try {
    validateStore(obj);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, store: obj };
}

/**
 * Load registry.
 * - Missing main → try .bak, else empty store.
 * - Corrupt/empty/unsupported main → try valid .bak (recovery).
 * - Both corrupt → throw explicit error (never silent empty replace of existing files).
 */
export function loadExperiments() {
  const current = storePath();
  const bak = storePath(REGISTRY_BAK);
  const main = tryLoadRegistryFile(current);
  if (main.ok) return main.store;

  const backup = tryLoadRegistryFile(bak);
  if (backup.ok) return backup.store;

  // Neither main nor bak is valid
  if (!existsSync(current) && !existsSync(bak)) {
    return emptyStore();
  }
  const parts = [];
  if (existsSync(current)) parts.push(`main (${main.error})`);
  if (existsSync(bak)) parts.push(`backup (${backup.error})`);
  throw new Error(
    `Experiment registry unreadable; recovery failed: ${parts.join('; ')}`,
  );
}

function atomicSaveStore(store) {
  validateStore(store);
  const dir = experimentsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = storePath(REGISTRY_TMP);
  const current = storePath(REGISTRY_FILE);
  const bak = storePath(REGISTRY_BAK);
  const body = JSON.stringify(store, null, 2);

  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const written = JSON.parse(readFileSync(tmp, 'utf8'));
  validateStore(written);

  if (existsSync(current)) {
    try {
      renameSync(current, bak);
    } catch {
      try {
        unlinkSync(bak);
        renameSync(current, bak);
      } catch {
        /* best-effort backup rotation */
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
      if (err.code !== 'EIO' && attempt === 2) {
        throw new Error(`Experiment registry rename failed: ${err.message}`);
      }
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  if (!promoted) {
    throw new Error(
      `Experiment registry atomic rename failed after retries: ${lastErr?.message || 'unknown'}`,
    );
  }

  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
  return current;
}

/**
 * Stable fingerprint: recursive key-sorted JSON so object key order does not change the hash.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function configFingerprint(config) {
  return createHash('sha256').update(stableStringify(config ?? {})).digest('hex').slice(0, 16);
}

/**
 * Create experiment. Same-process lock held during load+mutate+save.
 * Duplicate id throws. Does not overwrite an existing different experiment.
 */
export function createExperiment(input = {}) {
  return withRegistryLock(() => {
    if (!input.strategyId || !input.strategyVersion) {
      throw new Error('strategyId and strategyVersion are required');
    }
    const store = loadExperiments();
    const id = input.id || randomUUID();
    if (store.experiments.some((e) => e.id === id)) {
      throw new Error(`Experiment id collision: ${id}`);
    }
    const config = input.config || {};
    let provenance;
    if (input.provenance) {
      provenance = { ...input.provenance };
    } else if (input.dataSource) {
      provenance = { provider: input.dataSource, realtime: false };
    } else {
      provenance = { provider: 'unknown', realtime: false, note: 'provenance unavailable' };
    }
    const record = {
      id,
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      config,
      configFingerprint: configFingerprint(config),
      datasetIdentity: input.datasetIdentity ?? null,
      dataSource: input.dataSource ?? 'unknown',
      provenance,
      evaluationMethod: input.evaluationMethod || 'backtest',
      status: 'created',
      createdAt: input.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      metrics: null,
      datasetReportSummary: null,
      evaluation: null,
      parentId: input.parentId || null,
      error: null,
      note: 'Experiment record only. Not a trading approval. Synthetic results do not imply profitability.',
    };
    store.experiments.push(record);
    atomicSaveStore(store);
    return record;
  });
}

export function getExperiment(id) {
  return loadExperiments().experiments.find((e) => e.id === id) || null;
}

/**
 * Patch experiment fields. Status must be one of the allowed set.
 */
export function updateExperiment(id, patch = {}) {
  return withRegistryLock(() => {
    const store = loadExperiments();
    const idx = store.experiments.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`Experiment not found: ${id}`);
    const current = store.experiments[idx];
    if (patch.status && !STATUSES.has(patch.status)) {
      throw new Error(`Invalid experiment status: ${patch.status}`);
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    store.experiments[idx] = next;
    atomicSaveStore(store);
    return next;
  });
}

/** Test helpers */
export const _paths = {
  file: () => storePath(REGISTRY_FILE),
  bak: () => storePath(REGISTRY_BAK),
  tmp: () => storePath(REGISTRY_TMP),
  dir: experimentsDir,
};

export function _withRegistryLock(fn) {
  return withRegistryLock(fn);
}
