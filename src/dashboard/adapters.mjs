/**
 * Read-only dashboard adapters.
 * Reuse existing modules. Never invent metrics. Never return secrets.
 * Failures become explicit unavailable/error states.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { resolveProjectPath } from '../paths.mjs';
import { loadExperiments, getExperiment } from '../experiments/registry.mjs';
import { listLearningRecords } from '../experiments/learning.mjs';
import { listHypotheses, getHypothesis } from '../ai/agent.mjs';
import { listProposals, getProposal, validateProposal } from '../ai/proposals.mjs';
import { listMemoryNotes } from '../ai/memory.mjs';
import { getProviderStatus } from '../ai/provider.mjs';
import { loadEvents, eventStats } from '../audit/events.mjs';
import { loadSnapshot } from '../persistence/store.mjs';
import { isCacheFresh, DEFAULT_FRESHNESS_MS, readMarketCache } from '../market-data/cache.mjs';

const SECRET_KEYS = /key|secret|token|password|authorization|credential/i;

export function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function tryCall(fn, fallback) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err?.message || 'unavailable', fallback };
  }
}

export function getSafeConfigSummary() {
  const config = loadConfig();
  return {
    name: config.project?.name || 'FabInvests',
    agent: config.project?.agentName || 'NEXORA',
    mode: config.project?.mode || 'paper',
    paperTradingOnly: config.safety?.paperTradingOnly === true,
    allowRealOrders: config.safety?.allowRealOrders === true,
    requireVerifiedMarketData: config.safety?.requireVerifiedMarketData === true,
    blockTradingOnStaleData: config.safety?.blockTradingOnStaleData === true,
    initialVirtualCapital: config.capital?.initialVirtualCapital ?? null,
    currency: config.capital?.currency || 'USD',
    loopSeconds: config.runtime?.loopSeconds ?? null,
    dashboardPort: config.runtime?.dashboardPort ?? null,
    timezone: config.runtime?.timezone || 'UTC',
    liveTradingEnabled: false,
  };
}

export function getMarketStatus() {
  const keyConfigured = Boolean(process.env.FABINVESTS_ALPHAVANTAGE_KEY);
  const caches = [];
  const marketDir = resolveProjectPath('data/market');
  if (existsSync(marketDir)) {
    for (const provider of readdirSync(marketDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const providerDir = join(marketDir, provider.name);
      for (const file of readdirSync(providerDir)) {
        if (!file.endsWith('.json')) continue;
        const symbol = file.replace(/\.json$/, '');
        try {
          const record = readMarketCache(provider.name, symbol);
          if (!record) continue;
          caches.push({
            provider: provider.name,
            symbol,
            candleCount: Array.isArray(record.candles) ? record.candles.length : 0,
            retrievedAt: record.retrievedAt ?? null,
            fresh: isCacheFresh(record, DEFAULT_FRESHNESS_MS),
            provenance: redact(record.provenance || null),
            quality: record.datasetReport
              ? { ok: record.datasetReport.ok, errorCount: record.datasetReport.errorCount, warningCount: record.datasetReport.warningCount }
              : null,
          });
        } catch (err) {
          caches.push({
            provider: provider.name,
            symbol,
            unreadable: true,
            error: err.message,
          });
        }
      }
    }
  }
  return {
    defaultProvider: 'synthetic',
    syntheticAvailable: true,
    alphavantage: {
      available: keyConfigured,
      keyConfigured,
      realtime: false,
      note: keyConfigured
        ? 'Key is configured. Dashboard does not fetch on open. Daily data is not real-time.'
        : 'Not configured. Set FABINVESTS_ALPHAVANTAGE_KEY to enable. No network call is made by the dashboard.',
    },
    automaticFetch: false,
    caches,
    note: 'Synthetic data remains the default. Cached provider data is labeled by provenance and is not live.',
  };
}

export function getExperimentList() {
  const loaded = tryCall(() => loadExperiments());
  if (!loaded.ok) {
    return { ok: false, experiments: [], error: loaded.error };
  }
  const experiments = (loaded.value.experiments || []).map(summarizeExperiment);
  const byStatus = {};
  for (const exp of experiments) {
    byStatus[exp.status] = (byStatus[exp.status] || 0) + 1;
  }
  return { ok: true, experiments, byStatus, total: experiments.length };
}

export function getExperimentDetail(id) {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'Invalid experiment id' };
  const exp = tryCall(() => getExperiment(safe));
  if (!exp.ok) return { ok: false, error: exp.error };
  if (!exp.value) return { ok: false, error: 'Experiment not found' };
  return { ok: true, experiment: summarizeExperiment(exp.value, true) };
}

function summarizeExperiment(exp, detailed = false) {
  const base = {
    id: exp.id,
    status: exp.status || 'unknown',
    strategyId: exp.strategyId,
    strategyVersion: exp.strategyVersion,
    configFingerprint: exp.configFingerprint || null,
    evaluationMethod: exp.evaluationMethod || null,
    dataSource: exp.dataSource || 'unknown',
    provenance: redact(exp.provenance || null),
    datasetIdentity: exp.datasetIdentity || null,
    datasetReportSummary: exp.datasetReportSummary || null,
    metrics: exp.metrics || null,
    sampleStatus: exp.metrics?.sampleStatus || null,
    createdAt: exp.createdAt || null,
    updatedAt: exp.updatedAt || null,
    finishedAt: exp.finishedAt || null,
    error: exp.error || null,
    parentId: exp.parentId || null,
    note: exp.note || null,
  };
  if (detailed) {
    base.evaluation = exp.evaluation || null;
    base.config = redact(exp.config || {});
  }
  return base;
}

export function getAiStatus() {
  const provider = getProviderStatus();
  const hypotheses = tryCall(() => listHypotheses());
  const proposals = tryCall(() => listProposals());
  const memory = tryCall(() => listMemoryNotes());
  return {
    provider: {
      ...provider,
      mock: provider.provider === 'mock',
      label: provider.provider === 'mock'
        ? 'Mock provider — not an external LLM'
        : (provider.available ? provider.provider : 'Unavailable'),
    },
    hypothesisCount: hypotheses.ok ? hypotheses.value.length : null,
    proposalCount: proposals.ok ? proposals.value.length : null,
    memoryCount: memory.ok ? memory.value.length : null,
    hypothesesError: hypotheses.ok ? null : hypotheses.error,
    proposalsError: proposals.ok ? null : proposals.error,
    liveTradingEnabled: false,
  };
}

export function getHypothesisList() {
  const loaded = tryCall(() => listHypotheses());
  if (!loaded.ok) return { ok: false, hypotheses: [], error: loaded.error };
  return { ok: true, hypotheses: loaded.value.map(summarizeHypothesis) };
}

export function getHypothesisDetail(id) {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'Invalid hypothesis id' };
  const h = tryCall(() => getHypothesis(safe));
  if (!h.ok) return { ok: false, error: h.error };
  if (!h.value) return { ok: false, error: 'Hypothesis not found' };
  return { ok: true, hypothesis: summarizeHypothesis(h.value) };
}

function summarizeHypothesis(h) {
  return {
    id: h.id,
    experimentId: h.experimentId || (Array.isArray(h.experimentIds) ? h.experimentIds[0] : null),
    experimentIds: h.experimentIds || [],
    status: h.status || null,
    provider: h.provider || null,
    mock: h.provider === 'mock' || h.mock === true,
    researchQuestion: h.researchQuestion || null,
    proposedChange: h.proposedChange || null,
    expectedOutcome: h.expectedOutcome || null,
    falsification: h.falsification || null,
    uncertainty: h.uncertainty || null,
    evidenceRefs: h.evidenceRefs || h.experimentIds || [],
    createdAt: h.createdAt || null,
    note: h.note || null,
  };
}

export function getProposalList() {
  const loaded = tryCall(() => listProposals());
  if (!loaded.ok) return { ok: false, proposals: [], error: loaded.error };
  return { ok: true, proposals: loaded.value.map(summarizeProposal) };
}

export function getProposalDetail(id) {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'Invalid proposal id' };
  const p = tryCall(() => getProposal(safe));
  if (!p.ok) return { ok: false, error: p.error };
  if (!p.value) return { ok: false, error: 'Proposal not found' };
  return { ok: true, proposal: summarizeProposal(p.value) };
}

function summarizeProposal(p) {
  return {
    id: p.id,
    hypothesisId: p.hypothesisId,
    experimentIds: p.experimentIds || [],
    status: p.status || 'unknown',
    evaluationMethod: p.evaluationMethod || null,
    validationReasons: p.validationReasons || [],
    liveTradingEnabled: p.liveTradingEnabled === true,
    autoExecute: p.autoExecute === true,
    createdAt: p.createdAt || null,
    validatedAt: p.validatedAt || null,
    note: p.note || null,
  };
}

/**
 * Deterministic validation only. Does not execute trades or change strategy config.
 */
export function runProposalValidation(id) {
  const safe = safeId(id);
  if (!safe) return { ok: false, error: 'Invalid proposal id' };
  try {
    const result = validateProposal(safe);
    return { ok: true, proposal: summarizeProposal(result), liveTradingEnabled: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function getPaperStatus() {
  const config = getSafeConfigSummary();
  const snap = tryCall(() => loadSnapshot());
  if (!snap.ok) {
    return {
      ok: false,
      simulated: true,
      status: 'unavailable',
      error: snap.error,
      capital: config.initialVirtualCapital,
      currency: config.currency,
      liveTradingEnabled: false,
    };
  }
  if (!snap.value) {
    return {
      ok: true,
      simulated: true,
      status: 'not_configured',
      message: 'No paper snapshot. No session has been persisted. All execution remains simulated.',
      capital: config.initialVirtualCapital,
      currency: config.currency,
      liveTradingEnabled: false,
    };
  }
  const ledger = snap.value.ledger?.snapshot?.() || null;
  return {
    ok: true,
    simulated: true,
    status: 'snapshot',
    source: snap.value.source,
    capital: config.initialVirtualCapital,
    currency: config.currency,
    cash: ledger?.cash ?? null,
    positionQty: ledger?.positionQty ?? null,
    equity: ledger?.equity ?? null,
    realizedPnl: ledger?.realizedPnl ?? null,
    unrealizedPnl: ledger?.unrealizedPnl ?? null,
    riskState: redact(snap.value.riskState || null),
    liveTradingEnabled: false,
    note: 'Paper snapshot only. Not a live account. Not real money.',
  };
}

export function getAuditSummary(limit = 20) {
  const stats = tryCall(() => eventStats());
  const loaded = tryCall(() => loadEvents());
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, stats: stats.ok ? stats.value : null };
  }
  const events = loaded.value.events.slice(-Math.max(1, Math.min(limit, 100))).reverse().map((e) => ({
    eventId: e.eventId,
    type: e.type || e.eventType || null,
    timestamp: e.timestamp || e.createdAt || null,
    orderId: e.orderId || null,
    strategyId: e.strategyId || null,
    outcome: e.outcome || e.status || null,
  }));
  return {
    ok: true,
    stats: stats.ok ? stats.value : null,
    recent: events,
    note: 'Local audit trail. Not a regulatory record. Multi-process writers are unsupported.',
  };
}

export function getLearningLoop() {
  const experiments = getExperimentList();
  const ai = getAiStatus();
  const learning = tryCall(() => listLearningRecords());
  const proposals = getProposalList();
  const paper = getPaperStatus();

  const expList = experiments.ok ? experiments.experiments : [];
  const completed = expList.filter((e) => e.status === 'completed').length;
  const learningCount = learning.ok ? learning.value.length : 0;
  const hypothesisCount = ai.hypothesisCount || 0;
  const proposalCount = ai.proposalCount || 0;
  const validated = proposals.ok ? proposals.proposals.filter((p) => p.status === 'validated').length : 0;

  const stages = [
    { id: 'experiment', label: 'Experiment', ready: expList.length > 0, count: expList.length, blocking: expList.length === 0 ? 'No experiments recorded' : null },
    { id: 'evaluate', label: 'Evaluate', ready: completed > 0, count: completed, blocking: completed === 0 ? 'No completed evaluations' : null },
    { id: 'learn', label: 'Learn', ready: learningCount > 0, count: learningCount, blocking: learningCount === 0 ? 'No learning records' : null },
    { id: 'propose', label: 'Propose', ready: hypothesisCount > 0, count: hypothesisCount, blocking: hypothesisCount === 0 ? 'No hypotheses' : null },
    { id: 'validate', label: 'Validate', ready: validated > 0, count: proposalCount, blocking: proposalCount === 0 ? 'No proposals' : (validated === 0 ? 'No validated proposals' : null) },
    { id: 'paper', label: 'Paper-test', ready: paper.status === 'snapshot', count: paper.status === 'snapshot' ? 1 : 0, blocking: paper.status === 'snapshot' ? null : 'No persisted paper snapshot' },
    { id: 'improve', label: 'Improve', ready: false, count: 0, blocking: 'Automatic improvement is not implemented. Review records manually.' },
  ];

  return {
    stages,
    experiments: experiments.ok ? experiments.total : null,
    experimentsError: experiments.ok ? null : experiments.error,
    learningCount,
    learningError: learning.ok ? null : learning.error,
    hypotheses: hypothesisCount,
    proposals: proposalCount,
    validated,
    paperStatus: paper.status,
    liveTradingEnabled: false,
    note: 'Status is derived from stored records. UI progress is not promotion.',
  };
}

export function getOverview() {
  const config = getSafeConfigSummary();
  const experiments = getExperimentList();
  const ai = getAiStatus();
  const market = getMarketStatus();
  const paper = getPaperStatus();
  const audit = getAuditSummary(5);
  const loop = getLearningLoop();
  return {
    config,
    experiments: {
      total: experiments.ok ? experiments.total : null,
      byStatus: experiments.ok ? experiments.byStatus : {},
      error: experiments.ok ? null : experiments.error,
    },
    ai,
    market: {
      defaultProvider: market.defaultProvider,
      alphavantageConfigured: market.alphavantage.keyConfigured,
      cacheCount: market.caches.length,
    },
    paper,
    audit: {
      stats: audit.stats,
      recentCount: audit.ok ? audit.recent.length : 0,
      error: audit.ok ? null : audit.error,
    },
    loop,
    liveTradingEnabled: false,
  };
}
