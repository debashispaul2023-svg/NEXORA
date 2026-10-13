import { validateHistoricalSeries } from './input.mjs';
import { BacktestEngine } from './engine.mjs';
import { MarketDataError } from '../errors.mjs';
import { STRATEGY_ID, STRATEGY_VERSION } from '../strategies/baseline.mjs';

/**
 * Fixed-parameter walk-forward evaluation.
 *
 * Window semantics (inclusive start, exclusive end):
 * - Window i starts at index i * stepBars.
 * - Warm-up occupies [start, start + warmupBars).
 * - Evaluation occupies [start + warmupBars, start + warmupBars + evalBars).
 * - The engine receives only candles[start, evalEnd).
 * - Candles after evalEnd are never passed to that window.
 *
 * Each window uses a fresh engine, ledger, and workflow with the same
 * starting capital. Window results are not chained. Parameters are not
 * fitted against evaluation outcomes.
 *
 * Fill timing is the Phase 10 end-of-bar model inside BacktestEngine.
 * Synthetic results do not imply profitability or future performance.
 */

export function validateWalkForwardConfig(config = {}) {
  const warmupBars = config.warmupBars ?? 0;
  const evalBars = config.evalBars;
  const stepBars = config.stepBars ?? config.evalBars;

  for (const [name, value] of [
    ['warmupBars', warmupBars],
    ['evalBars', evalBars],
    ['stepBars', stepBars],
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new MarketDataError(`${name} must be a non-negative integer`, { [name]: value });
    }
  }
  if (evalBars < 1) {
    throw new MarketDataError('evalBars must be at least 1', { evalBars });
  }
  if (stepBars < 1) {
    throw new MarketDataError('stepBars must be at least 1', { stepBars });
  }
  return { warmupBars, evalBars, stepBars };
}

/**
 * Build chronological window bounds. Incomplete trailing windows are omitted.
 * @returns {{ index: number, start: number, warmupEnd: number, evalEnd: number }[]}
 */
export function buildWalkForwardWindows(seriesLength, config) {
  const { warmupBars, evalBars, stepBars } = validateWalkForwardConfig(config);
  if (!Number.isInteger(seriesLength) || seriesLength < 1) {
    throw new MarketDataError('seriesLength must be a positive integer', { seriesLength });
  }
  const windowSpan = warmupBars + evalBars;
  if (windowSpan > seriesLength) {
    throw new MarketDataError('Window is larger than the series', { windowSpan, seriesLength });
  }

  const windows = [];
  for (let start = 0; start + windowSpan <= seriesLength; start += stepBars) {
    windows.push({
      index: windows.length,
      start,
      warmupEnd: start + warmupBars,
      evalEnd: start + windowSpan,
    });
  }
  if (windows.length === 0) {
    throw new MarketDataError('Configuration produces no complete evaluation window');
  }
  return windows;
}

/**
 * Run independent walk-forward windows on a validated chronological series.
 * @param {object[]} candles
 * @param {object} [opts]
 */
export async function runWalkForward(candles, opts = {}) {
  const validated = validateHistoricalSeries(candles);
  const series = validated.series;
  const config = validateWalkForwardConfig(opts);
  const windows = buildWalkForwardWindows(series.length, config);
  const initialCapital = opts.initialCapital ?? 1000;
  const engineOpts = {
    evaluate: opts.evaluate,
    riskLimits: opts.riskLimits || {},
    slippageBps: opts.slippageBps ?? 0,
    initialCapital,
    audit: false,
  };

  const results = [];
  let failed = 0;
  for (const w of windows) {
    const slice = series.slice(w.start, w.evalEnd);
    try {
      const engine = new BacktestEngine(engineOpts);
      const run = await engine.run(slice, opts.params || {});
      const m = run.metrics;
      results.push({
        index: w.index,
        start: w.start,
        warmupEnd: w.warmupEnd,
        evalEnd: w.evalEnd,
        evalBars: config.evalBars,
        warmupBars: config.warmupBars,
        startTs: slice[0].timestamp,
        endTs: slice[slice.length - 1].timestamp,
        seriesCount: slice.length,
        startingCapital: initialCapital,
        endingEquity: m.endingEquity,
        realizedPnl: m.realizedPnl,
        totalFees: m.totalFees,
        completedTrades: m.completedTrades,
        winRate: m.winRate,
        maxDrawdown: m.maxDrawdown,
        strategyRealizedPnl: null,
        status: 'ok',
        synthetic: slice.some((c) => c.source === 'synthetic'),
      });
    } catch (err) {
      failed += 1;
      results.push({
        index: w.index,
        start: w.start,
        warmupEnd: w.warmupEnd,
        evalEnd: w.evalEnd,
        status: 'failed',
        error: err.message,
        endingEquity: null,
        realizedPnl: null,
        winRate: null,
        maxDrawdown: null,
        completedTrades: null,
      });
    }
  }

  return summarizeWalkForward({
    seriesIdentity: validated.identity,
    seriesCount: series.length,
    config,
    initialCapital,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    windows: results,
    failed,
    synthetic: series.some((c) => c.source === 'synthetic'),
  });
}

export function summarizeWalkForward({
  seriesIdentity,
  seriesCount,
  config,
  initialCapital,
  strategyId,
  strategyVersion,
  windows,
  failed = 0,
  synthetic = false,
}) {
  const ok = windows.filter((w) => w.status === 'ok');
  const pnl = ok.map((w) => (w.endingEquity != null ? w.endingEquity - w.startingCapital : null));
  const profitable = ok.filter((w) => w.endingEquity != null && w.endingEquity > w.startingCapital);
  const unprofitable = ok.filter((w) => w.endingEquity != null && w.endingEquity < w.startingCapital);
  const totalTrades = ok.reduce((s, w) => s + (w.completedTrades || 0), 0);
  const totalFees = ok.reduce((s, w) => s + (w.totalFees || 0), 0);
  const totalEvalCandles = ok.reduce((s, w) => s + (w.evalBars || 0), 0);

  let best = null;
  let worst = null;
  for (const w of ok) {
    if (w.endingEquity == null) continue;
    const delta = w.endingEquity - w.startingCapital;
    if (!best || delta > best.delta) best = { index: w.index, delta, endingEquity: w.endingEquity };
    if (!worst || delta < worst.delta) worst = { index: w.index, delta, endingEquity: w.endingEquity };
  }

  const sampleTooSmall = ok.length < 3 || totalTrades < 5;

  return {
    seriesIdentity,
    seriesCount,
    strategyId,
    strategyVersion,
    config,
    initialCapital,
    capitalModel: 'independent_per_window',
    fillModel: 'end_of_bar_close',
    parameterFitting: false,
    synthetic,
    windowsAttempted: windows.length,
    windowsSucceeded: ok.length,
    windowsFailed: failed,
    totalEvaluationCandles: totalEvalCandles,
    totalCompletedTrades: totalTrades,
    totalFees,
    profitableWindows: profitable.length,
    unprofitableWindows: unprofitable.length,
    bestWindow: best,
    worstWindow: worst,
    sampleTooSmall,
    windows,
    note: 'Independent windows with fixed parameters. Positive aggregate P&L does not imply robustness or future performance. Synthetic results do not imply profitability. strategyRealizedPnl is unavailable.',
  };
}
