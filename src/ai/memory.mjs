import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveProjectPath } from '../paths.mjs';
import { getExperiment } from '../experiments/registry.mjs';

/**
 * AI interpretation notes. Separate from Phase 20 learning records.
 * Facts vs interpretation are explicit. Not model training.
 */

export const MEMORY_SCHEMA = 1;

function dirPath() {
  return resolveProjectPath(join('data', 'experiments'));
}
function storePath() {
  return join(dirPath(), 'ai-memory.json');
}

function emptyStore() {
  return { schemaVersion: MEMORY_SCHEMA, notes: [] };
}

function loadStore() {
  const path = storePath();
  if (!existsSync(path)) return emptyStore();
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) throw new Error('AI memory store is empty or truncated');
  const obj = JSON.parse(raw);
  if (obj.schemaVersion !== MEMORY_SCHEMA) {
    throw new Error(`Unsupported AI memory schema: ${obj.schemaVersion}`);
  }
  return obj;
}

function saveStore(store) {
  if (!existsSync(dirPath())) mkdirSync(dirPath(), { recursive: true, mode: 0o700 });
  const tmp = storePath() + '.tmp';
  const body = JSON.stringify(store, null, 2);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, storePath());
  if (existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function listMemoryNotes(experimentId = null) {
  const notes = loadStore().notes;
  return experimentId ? notes.filter((n) => n.experimentId === experimentId) : notes;
}

/**
 * Record an interpretation note linked to a real experiment.
 * Idempotent on experimentId + kind.
 */
export function recordInterpretation({ experimentId, kind = 'summary', interpretation }) {
  const experiment = getExperiment(experimentId);
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
  if (experiment.status !== 'completed') {
    throw new Error('AI memory requires a completed experiment');
  }
  if (!interpretation || typeof interpretation !== 'string') {
    throw new Error('interpretation text is required');
  }

  const id = createHash('sha256').update(`${experimentId}|${kind}`).digest('hex').slice(0, 16);
  const store = loadStore();
  const existing = store.notes.find((n) => n.id === id);
  if (existing) return existing;

  const note = {
    id,
    schemaVersion: MEMORY_SCHEMA,
    experimentId,
    kind,
    facts: {
      status: experiment.status,
      sampleStatus: experiment.metrics?.sampleStatus ?? null,
      datasetOk: experiment.datasetReportSummary?.ok ?? null,
      evaluationMethod: experiment.evaluationMethod,
    },
    interpretation,
    createdAt: new Date().toISOString(),
    liveTradingEnabled: false,
    note: 'Interpretation is not a measured fact. Not a trained model.',
  };
  store.notes.push(note);
  saveStore(store);
  return note;
}
