/**
 * AI provider abstraction.
 * Mock provider is deterministic and offline.
 * Missing provider returns unavailable — never a fabricated response.
 * No API keys are hardcoded. Paid services are not enabled by default.
 */

export const PROVIDER_SCHEMA = 1;

export function getProviderStatus() {
  const name = process.env.FABINVESTS_AI_PROVIDER || 'mock';
  if (name === 'none' || name === 'unavailable') {
    return { available: false, provider: name, reason: 'AI provider disabled' };
  }
  if (name === 'mock') {
    return { available: true, provider: 'mock', realtime: false, paid: false };
  }
  // Optional external adapter is not configured in this phase.
  return {
    available: false,
    provider: name,
    reason: `Provider "${name}" is not configured. Use mock or leave unset.`,
  };
}

/**
 * Deterministic mock: builds a structured hypothesis draft from experiment evidence.
 * Does not invent metrics. Does not claim profitability.
 */
export async function completeResearchRequest(request) {
  const status = getProviderStatus();
  if (!status.available) {
    return {
      ok: false,
      unavailable: true,
      provider: status.provider,
      reason: status.reason || 'AI unavailable',
    };
  }
  if (status.provider !== 'mock') {
    return { ok: false, unavailable: true, provider: status.provider, reason: 'Unsupported provider' };
  }
  if (!request || !Array.isArray(request.experiments) || request.experiments.length === 0) {
    return { ok: false, unavailable: false, reason: 'No experiment evidence supplied' };
  }

  const exp = request.experiments[0];
  const sample = exp.metrics?.sampleStatus || 'unknown';
  const draft = {
    researchQuestion: `Does configuration fingerprint ${exp.configFingerprint || 'unknown'} improve descriptive sample status beyond ${sample}?`,
    proposedChange: 'Repeat evaluation on a longer synthetic series with the same fixed parameters.',
    expectedOutcome: 'sampleStatus moves to measured or adequate_for_description_only, or the hypothesis is falsified.',
    baseline: exp.id,
    evaluationMethod: exp.evaluationMethod === 'walk-forward' ? 'walk-forward' : 'walk-forward',
    riskConstraints: { maxDrawdown: 0.2, liveTradingEnabled: false },
    falsification: 'If sampleStatus remains insufficient or dataset quality fails, reject the change.',
    uncertainty: 'Mock provider only. Historical metrics are not a claim of future performance.',
    evidenceRefs: [exp.id],
    citedMetrics: {
      sampleStatus: sample,
      datasetOk: exp.datasetReportSummary?.ok ?? null,
    },
  };
  return {
    ok: true,
    provider: 'mock',
    draft,
    note: 'Mock response. Not a trained model. Synthetic results do not imply profitability.',
  };
}
