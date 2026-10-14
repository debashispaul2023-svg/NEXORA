import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { getExperiment, loadExperiments } from '../experiments/registry.mjs';
import { completeResearchRequest, getProviderStatus } from './provider.mjs';

export const HYPOTHESIS_SCHEMA = 1;

function dirPath() {
  return resolveProjectPath(join('data', 'experiments'));
}
function storePath() {
  return join(dirPath(), 'hypotheses.json');
}

function emptyStore() {
  return { schemaVersion: HYPOTHESIS_SCHEMA, hypotheses: [] };
}

function loadStore() {
  const path = storePath();
  if (!existsSync(path)) return emptyStore();
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) throw new Error('Hypothesis store is empty or truncated');
  const obj = JSON.parse(raw);
  if (obj.schemaVersion !== HYPOTHESIS_SCHEMA) {
    throw new Error(`Unsupported hypothesis schema: ${obj.schemaVersion}`);
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

export function listHypotheses() {
  return loadStore().hypotheses;
}

export function getHypothesis(id) {
  return loadStore().hypotheses.find((h) => h.id === id) || null;
}

function stableId(experimentId, fingerprint) {
  return createHash('sha256').update(`${experimentId}|${fingerprint}|v1`).digest('hex').slice(0, 16);
}

/**
 * Generate a hypothesis from a completed experiment.
 * AI output is validated before storage. Unavailable provider does not invent content.
 */
export async function generateHypothesis(experimentId) {
  const experiment = getExperiment(experimentId);
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
  if (experiment.status !== 'completed') {
    throw new Error('Hypotheses require a completed experiment');
  }

  const status = getProviderStatus();
  if (!status.available) {
    return { ok: false, unavailable: true, reason: status.reason || 'AI unavailable' };
  }

  const ai = await completeResearchRequest({ experiments: [experiment] });
  if (!ai.ok) {
    return { ok: false, unavailable: ai.unavailable === true, reason: ai.reason || 'AI request failed' };
  }

  const draft = ai.draft;
  if (!draft?.researchQuestion || !Array.isArray(draft.evidenceRefs)) {
    throw new Error('AI draft failed schema validation');
  }
  if (!draft.evidenceRefs.includes(experiment.id)) {
    throw new Error('AI draft does not reference the source experiment');
  }
  if (draft.citedMetrics?.sampleStatus !== (experiment.metrics?.sampleStatus || 'unknown')) {
    throw new Error('AI cited sampleStatus does not match stored evidence');
  }

  const id = stableId(experiment.id, experiment.configFingerprint || 'none');
  const store = loadStore();
  const existing = store.hypotheses.find((h) => h.id === id);
  if (existing) return { ok: true, hypothesis: existing, duplicate: true };

  const hypothesis = {
    id,
    schemaVersion: HYPOTHESIS_SCHEMA,
    createdAt: new Date().toISOString(),
    experimentIds: [experiment.id],
    researchQuestion: draft.researchQuestion,
    proposedChange: draft.proposedChange,
    expectedOutcome: draft.expectedOutcome,
    baseline: draft.baseline,
    dataset: experiment.datasetIdentity || 'unknown',
    evaluationMethod: draft.evaluationMethod,
    riskConstraints: { ...draft.riskConstraints, liveTradingEnabled: false },
    falsification: draft.falsification,
    evidenceRefs: draft.evidenceRefs,
    citedMetrics: draft.citedMetrics,
    uncertainty: draft.uncertainty,
    status: 'proposed',
    provider: ai.provider,
    note: 'Untrusted AI draft validated against stored evidence. Not a profitability claim.',
  };
  store.hypotheses.push(hypothesis);
  saveStore(store);
  return { ok: true, hypothesis, duplicate: false };
}

export function listCompletedExperiments() {
  return loadExperiments().experiments.filter((e) => e.status === 'completed');
}
