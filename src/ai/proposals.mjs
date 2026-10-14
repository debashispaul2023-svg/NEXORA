import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { getExperiment } from '../experiments/registry.mjs';
import { getHypothesis } from './agent.mjs';

export const PROPOSAL_SCHEMA = 1;
const STATES = new Set(['proposed', 'needs_review', 'validated', 'rejected', 'evaluated']);

function dirPath() {
  return resolveProjectPath(join('data', 'experiments'));
}
function storePath() {
  return join(dirPath(), 'proposals.json');
}

function emptyStore() {
  return { schemaVersion: PROPOSAL_SCHEMA, proposals: [] };
}

function loadStore() {
  const path = storePath();
  if (!existsSync(path)) return emptyStore();
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) throw new Error('Proposal store is empty or truncated');
  const obj = JSON.parse(raw);
  if (obj.schemaVersion !== PROPOSAL_SCHEMA) {
    throw new Error(`Unsupported proposal schema: ${obj.schemaVersion}`);
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

export function listProposals() {
  return loadStore().proposals;
}

export function getProposal(id) {
  return loadStore().proposals.find((p) => p.id === id) || null;
}

/**
 * Create a proposal from a hypothesis. Does not execute trades or change strategy config.
 */
export function createProposal(hypothesisId) {
  const hypothesis = getHypothesis(hypothesisId);
  if (!hypothesis) throw new Error(`Hypothesis not found: ${hypothesisId}`);

  const id = createHash('sha256').update(`proposal|${hypothesisId}`).digest('hex').slice(0, 16);
  const store = loadStore();
  const existing = store.proposals.find((p) => p.id === id);
  if (existing) return { proposal: existing, duplicate: true };

  const proposal = {
    id,
    schemaVersion: PROPOSAL_SCHEMA,
    hypothesisId,
    experimentIds: [...hypothesis.experimentIds],
    proposedChange: hypothesis.proposedChange,
    evaluationMethod: hypothesis.evaluationMethod,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    liveTradingEnabled: false,
    autoExecute: false,
    note: 'Proposal only. Does not submit orders or change strategy configuration.',
  };
  store.proposals.push(proposal);
  saveStore(store);
  return { proposal, duplicate: false };
}

/**
 * Deterministic validation against stored evidence and risk constraints.
 * Does not enable live trading. Does not auto-run evaluation.
 */
export function validateProposal(proposalId) {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  const reasons = [];

  const hypothesis = getHypothesis(proposal.hypothesisId);
  if (!hypothesis) reasons.push('hypothesis_missing');

  for (const expId of proposal.experimentIds || []) {
    if (!getExperiment(expId)) reasons.push(`experiment_missing:${expId}`);
  }

  if (proposal.evaluationMethod !== 'walk-forward' && proposal.evaluationMethod !== 'backtest') {
    reasons.push('invalid_evaluation_method');
  }
  if (proposal.liveTradingEnabled === true) reasons.push('live_trading_forbidden');
  if (proposal.autoExecute === true) reasons.push('auto_execute_forbidden');

  const unique = [...new Set(reasons)];
  const nextStatus = unique.length === 0 ? 'validated' : 'rejected';

  const store = loadStore();
  const idx = store.proposals.findIndex((p) => p.id === proposalId);
  store.proposals[idx] = {
    ...store.proposals[idx],
    status: nextStatus,
    validationReasons: unique,
    liveTradingEnabled: false,
    autoExecute: false,
    validatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.proposals[idx];
}

export function setProposalStatus(proposalId, status) {
  if (!STATES.has(status)) throw new Error(`Invalid proposal status: ${status}`);
  const store = loadStore();
  const idx = store.proposals.findIndex((p) => p.id === proposalId);
  if (idx < 0) throw new Error(`Proposal not found: ${proposalId}`);
  store.proposals[idx] = {
    ...store.proposals[idx],
    status,
    liveTradingEnabled: false,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.proposals[idx];
}
