import { generateSyntheticSeries } from '../market-data/fixtures.mjs';
import { BacktestEngine } from '../backtest/engine.mjs';
import { runWalkForward } from '../backtest/walkforward.mjs';
import { fetchValidatedDaily } from '../market-data/provider.mjs';
import { logger } from '../logger.mjs';

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
  if (!flags.backtest && !flags.walkForward) {
    return { ran: false };
  }

  const capital = flags.capital ?? configCapital.initialVirtualCapital ?? 1000;
  let candles;
  let provenance = { provider: 'synthetic', realtime: false };

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

  return { ran: true };
}
