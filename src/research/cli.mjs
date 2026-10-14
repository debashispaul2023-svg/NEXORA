import { generateSyntheticSeries } from '../market-data/fixtures.mjs';
import { BacktestEngine } from '../backtest/engine.mjs';
import { runWalkForward } from '../backtest/walkforward.mjs';
import { fetchValidatedDaily } from '../market-data/provider.mjs';
import { runPaperSession } from '../paper/session.mjs';
import { logger } from '../logger.mjs';
import { getProviderStatus } from '../ai/provider.mjs';
import { generateHypothesis, listHypotheses } from '../ai/agent.mjs';
import { createProposal, listProposals, validateProposal } from '../ai/proposals.mjs';

/**
 * Minimal synthetic research CLI.
 * Reuses BacktestEngine and runWalkForward. Does not duplicate fill or accounting logic.
 * Synthetic data only. Results do not imply profitability.
 */

function parsePositiveInt(value, name, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseNonNegNumber(value, name, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

/**
 * Parse research-related CLI flags from argv.
 * @param {string[]} args
 */
export function parseResearchArgs(args) {
  const flags = {
    backtest: args.includes('--backtest'),
    walkForward: args.includes('--walk-forward'),
    paper: args.includes('--paper'),
    aiStatus: args.includes('--ai-status'),
    hypotheses: args.includes('--hypotheses'),
    listHypotheses: args.includes('--list-hypotheses'),
    propose: args.includes('--propose'),
    listProposals: args.includes('--list-proposals'),
    validateProposal: args.includes('--validate-proposal'),
    experimentId: null,
    hypothesisId: null,
    proposalId: null,
    count: 40,
    capital: 1000,
    slippageBps: 0,
    intervalMs: 60_000,
    warmupBars: 5,
    evalBars: 10,
    stepBars: 10,
    expectedIntervalMs: undefined,
    provider: 'synthetic',
    symbol: null,
  };

  for (const arg of args) {
    if (arg.startsWith('--count=')) flags.count = parsePositiveInt(arg.slice(8), 'count', 40);
    else if (arg.startsWith('--capital=')) flags.capital = parseNonNegNumber(arg.slice(10), 'capital', 1000);
    else if (arg.startsWith('--slippage-bps=')) flags.slippageBps = parseNonNegNumber(arg.slice(15), 'slippage-bps', 0);
    else if (arg.startsWith('--interval-ms=')) flags.intervalMs = parsePositiveInt(arg.slice(14), 'interval-ms', 60_000);
    else if (arg.startsWith('--warmup-bars=')) {
      const raw = arg.slice(14);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error('warmup-bars must be a non-negative integer');
      flags.warmupBars = n;
    } else if (arg.startsWith('--eval-bars=')) flags.evalBars = parsePositiveInt(arg.slice(12), 'eval-bars', 10);
    else if (arg.startsWith('--step-bars=')) flags.stepBars = parsePositiveInt(arg.slice(12), 'step-bars', 10);
    else if (arg.startsWith('--expected-interval-ms=')) {
      flags.expectedIntervalMs = parsePositiveInt(arg.slice(23), 'expected-interval-ms', undefined);
    } else if (arg.startsWith('--provider=')) {
      flags.provider = arg.slice(11).trim().toLowerCase() || 'synthetic';
    } else if (arg.startsWith('--symbol=')) {
      flags.symbol = arg.slice(9).trim().toUpperCase();
    } else if (arg.startsWith('--experiment-id=')) {
      flags.experimentId = arg.slice(16).trim();
    } else if (arg.startsWith('--hypothesis-id=')) {
      flags.hypothesisId = arg.slice(16).trim();
    } else if (arg.startsWith('--proposal-id=')) {
      flags.proposalId = arg.slice(14).trim();
    }
  }

  return flags;
}

function printBacktestSummary(result) {
  const m = result.metrics;
  const dr = result.datasetReport;
  logger.info('Synthetic backtest complete (not a profitability claim)', {
    synthetic: true,
    runId: result.runId,
    strategyId: result.strategyId,
    seriesCount: result.seriesCount,
    seriesIdentity: result.seriesIdentity,
    startingCapital: m.startingCapital,
    endingEquity: m.endingEquity,
    realizedPnl: m.realizedPnl,
    completedTrades: m.completedTrades,
    winRate: m.winRate,
    maxDrawdown: m.maxDrawdown,
    datasetOk: dr?.ok,
    datasetErrors: dr?.errorCount,
    datasetWarnings: dr?.warningCount,
  });
}

function printWalkForwardSummary(result) {
  const dr = result.datasetReport;
  logger.info('Synthetic walk-forward complete (not a profitability claim)', {
    synthetic: result.synthetic === true,
    capitalModel: result.capitalModel,
    windowsSucceeded: result.windowsSucceeded,
    windowsFailed: result.windowsFailed,
    totalCompletedTrades: result.totalCompletedTrades,
    profitableWindows: result.profitableWindows,
    unprofitableWindows: result.unprofitableWindows,
    flatWindows: result.flatWindows,
    aggregatePnl: result.aggregatePnl,
    sampleStatus: result.sampleStatus,
    datasetOk: dr?.ok,
    datasetErrors: dr?.errorCount,
    datasetWarnings: dr?.warningCount,
  });
}

/**
 * Run synthetic research jobs requested by CLI flags.
 * @param {ReturnType<typeof parseResearchArgs>} flags
 * @param {{ initialVirtualCapital?: number }} [configCapital]
 */
export async function runResearchCli(flags, configCapital = {}) {
  const aiRequested = flags.aiStatus || flags.hypotheses || flags.listHypotheses
    || flags.propose || flags.listProposals || flags.validateProposal;
  if (!flags.backtest && !flags.walkForward && !flags.paper && !aiRequested) {
    return { ran: false };
  }

  if (flags.aiStatus) {
    const status = getProviderStatus();
    logger.info('AI provider status', { ...status, liveTradingEnabled: false });
  }
  if (flags.hypotheses) {
    if (!flags.experimentId) throw new Error('--experiment-id is required for --hypotheses');
    const result = await generateHypothesis(flags.experimentId);
    logger.info('Hypothesis generation', {
      ok: result.ok,
      unavailable: result.unavailable === true,
      id: result.hypothesis?.id || null,
      duplicate: result.duplicate === true,
      reason: result.reason || null,
      liveTradingEnabled: false,
    });
  }
  if (flags.listHypotheses) {
    const items = listHypotheses();
    logger.info('Hypotheses', { count: items.length, ids: items.map((h) => h.id) });
  }
  if (flags.propose) {
    if (!flags.hypothesisId) throw new Error('--hypothesis-id is required for --propose');
    const result = createProposal(flags.hypothesisId);
    logger.info('Proposal created', {
      id: result.proposal.id,
      status: result.proposal.status,
      duplicate: result.duplicate,
      liveTradingEnabled: false,
    });
  }
  if (flags.listProposals) {
    const items = listProposals();
    logger.info('Proposals', { count: items.length, ids: items.map((p) => p.id) });
  }
  if (flags.validateProposal) {
    if (!flags.proposalId) throw new Error('--proposal-id is required for --validate-proposal');
    const result = validateProposal(flags.proposalId);
    logger.info('Proposal validated', {
      id: result.id,
      status: result.status,
      reasons: result.validationReasons || [],
      liveTradingEnabled: false,
    });
  }

  if (!flags.backtest && !flags.walkForward && !flags.paper) {
    return { ran: aiRequested, aiOnly: true };
  }

  const capital = flags.capital ?? configCapital.initialVirtualCapital ?? 1000;
  let candles;
  let provenance = { provider: 'synthetic', realtime: false };
  let cacheStatus = 'synthetic';

  if (!flags.provider || flags.provider === 'synthetic') {
    candles = generateSyntheticSeries({
      count: flags.count,
      intervalMs: flags.intervalMs,
      startPrice: 100,
      startTs: Date.UTC(2026, 0, 1),
    });
  } else {
    if (!flags.symbol) {
      throw new Error('--symbol is required when --provider is not synthetic');
    }
    const fetched = await fetchValidatedDaily({
      provider: flags.provider,
      symbol: flags.symbol,
      expectedIntervalMs: flags.expectedIntervalMs,
    });
    candles = fetched.candles;
    provenance = fetched.provenance || provenance;
    cacheStatus = fetched.cacheStatus || 'unknown';
    logger.info('Market data loaded (not real-time)', {
      provider: flags.provider,
      symbol: flags.symbol,
      cacheStatus: fetched.cacheStatus,
      seriesCount: candles.length,
      realtime: false,
      warning: fetched.warning || null,
    });
  }

  if (flags.backtest) {
    const engine = new BacktestEngine({
      initialCapital: capital,
      slippageBps: flags.slippageBps,
      audit: false,
    });
    const runOpts = {};
    if (flags.expectedIntervalMs != null) {
      runOpts.expectedIntervalMs = flags.expectedIntervalMs;
    }
    const result = await engine.run(candles, {}, runOpts);
    printBacktestSummary(result);
  }

  if (flags.walkForward) {
    const opts = {
      warmupBars: flags.warmupBars,
      evalBars: flags.evalBars,
      stepBars: flags.stepBars,
      initialCapital: capital,
      slippageBps: flags.slippageBps,
    };
    if (flags.expectedIntervalMs != null) {
      opts.expectedIntervalMs = flags.expectedIntervalMs;
    }
    const result = await runWalkForward(candles, opts);
    printWalkForwardSummary(result);
  }

  if (flags.paper) {
    const paper = await runPaperSession({
      candles,
      provenance,
      cacheStatus,
      initialCapital: capital,
      slippageBps: flags.slippageBps,
      expectedIntervalMs: flags.expectedIntervalMs,
      audit: false,
    });
    logger.info('Paper session complete (simulated, not real trading)', {
      synthetic: paper.synthetic,
      provider: paper.provenance.provider,
      seriesCount: paper.seriesCount,
      mutated: paper.mutated,
      cash: paper.snapshot.cash,
      positionQty: paper.snapshot.positionQty,
      realtime: false,
    });
  }

  return { ran: true };
}
