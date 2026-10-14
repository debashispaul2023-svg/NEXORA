import { getExperiment } from './registry.mjs';

/**
 * Promotion gate.
 * Highest return is not sufficient. Approval is research-only and never enables live trading.
 *
 * Missing evidence is treated as missing (fails the corresponding check), not as zero risk.
 * liveTradingEnabled is always false on every code path.
 */

export const DEFAULT_PROMOTION = Object.freeze({
  minSeriesCount: 20,
  maxDrawdown: 0.2,
  requireDatasetOk: true,
  requireOutOfSample: true,
  requireDrawdownMetric: true,
  allowedSampleStatus: ['measured', 'adequate_for_description_only'],
});

export function evaluatePromotion(experimentId, criteria = {}) {
  const experiment = getExperiment(experimentId);
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
  const rules = { ...DEFAULT_PROMOTION, ...criteria };
  const reasons = [];

  if (experiment.status !== 'completed') {
    reasons.push('experiment_not_completed');
  }

  if (rules.requireDatasetOk) {
    if (experiment.datasetReportSummary?.ok !== true) {
      reasons.push('dataset_not_ok');
    }
  }

  const sample = experiment.metrics?.sampleStatus;
  if (sample == null || sample === 'unknown') {
    reasons.push('sample_status_missing');
  } else if (!rules.allowedSampleStatus.includes(sample)) {
    reasons.push('insufficient_sample');
  }

  const seriesCount = experiment.evaluation?.seriesCount;
  if (!Number.isFinite(seriesCount)) {
    reasons.push('series_count_missing');
  } else if (seriesCount < rules.minSeriesCount) {
    reasons.push('series_too_short');
  }

  const dd = experiment.metrics?.maxDrawdown;
  if (rules.requireDrawdownMetric) {
    if (dd == null || !Number.isFinite(dd)) {
      // Walk-forward metrics may omit maxDrawdown; treat as missing evidence
      reasons.push('drawdown_metric_missing');
    } else if (dd > rules.maxDrawdown) {
      reasons.push('drawdown_exceeded');
    } else if (dd < 0) {
      reasons.push('drawdown_malformed');
    }
  } else if (Number.isFinite(dd)) {
    if (dd > rules.maxDrawdown) reasons.push('drawdown_exceeded');
    if (dd < 0) reasons.push('drawdown_malformed');
  }

  // Reject other non-finite numeric metrics when present
  if (experiment.metrics) {
    for (const [key, val] of Object.entries(experiment.metrics)) {
      if (typeof val === 'number' && !Number.isFinite(val)) {
        reasons.push(`metric_not_finite:${key}`);
      }
    }
  }

  if (rules.requireOutOfSample) {
    const method = experiment.evaluationMethod;
    const markedOos = experiment.evaluation?.outOfSample === true;
    if (method !== 'walk-forward' || !markedOos) {
      reasons.push('out_of_sample_missing');
    }
  }

  if (experiment.evaluationMethod === 'walk-forward') {
    const windows = experiment.metrics?.windowsSucceeded;
    if (!Number.isFinite(windows) || windows < 1) {
      reasons.push('no_successful_windows');
    }
  }

  // Deduplicate reasons
  const unique = [...new Set(reasons)];
  const approved = unique.length === 0;

  return {
    experimentId,
    approved,
    status: approved ? 'approved_research_only' : 'blocked',
    reasons: unique,
    liveTradingEnabled: false,
    note: approved
      ? 'Research approval only. Does not enable real-money trading or bypass paper risk controls.'
      : 'Promotion blocked. Highest return alone is never sufficient. Missing evidence is not treated as success.',
  };
}
