import { BacktestEngine } from '../backtest/engine.mjs';
import { runWalkForward } from '../backtest/walkforward.mjs';
import { updateExperiment, getExperiment } from './registry.mjs';
import { validateCandleSeries } from '../market-data/candle.mjs';

/**
 * Evaluate an experiment using existing engines.
 * Does not change fill, accounting, or risk semantics.
 *
 * Invalid candle series are rejected before status moves to completed.
 * Exceptions become status=failed without inventing metrics.
 * In-sample backtest is never labeled as walk-forward / out-of-sample.
 */

function summarizeReport(report) {
  if (!report) return null;
  return {
    ok: !!report.ok,
    errorCount: Number.isFinite(report.errorCount) ? report.errorCount : null,
    warningCount: Number.isFinite(report.warningCount) ? report.warningCount : null,
    infoCount: Number.isFinite(report.infoCount) ? report.infoCount : null,
  };
}

function seriesIsSynthetic(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  return candles.every((c) => c.source === 'synthetic');
}

export async function evaluateExperiment(id, candles, opts = {}) {
  const experiment = getExperiment(id);
  if (!experiment) throw new Error(`Experiment not found: ${id}`);

  // Fail closed on invalid input before marking running when possible
  try {
    validateCandleSeries(candles);
  } catch (err) {
    return updateExperiment(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: `Invalid dataset rejected before evaluation: ${err.message}`,
      metrics: null,
      datasetReportSummary: null,
    });
  }

  updateExperiment(id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    error: null,
  });

  try {
    const method = experiment.evaluationMethod || 'backtest';
    let result;
    if (method === 'walk-forward') {
      result = await runWalkForward(candles, {
        ...(experiment.config || {}),
        expectedIntervalMs: opts.expectedIntervalMs,
      });
    } else {
      const engine = new BacktestEngine({
        initialCapital: experiment.config?.initialCapital ?? 1000,
        slippageBps: experiment.config?.slippageBps ?? 0,
        audit: false,
      });
      result = await engine.run(candles, experiment.config?.params || {}, {
        expectedIntervalMs: opts.expectedIntervalMs,
      });
    }

    const synthetic = result.synthetic === true || seriesIsSynthetic(candles);

    const metrics = method === 'walk-forward'
      ? {
          sampleStatus: result.sampleStatus,
          windowsSucceeded: result.windowsSucceeded,
          windowsFailed: result.windowsFailed,
          totalCompletedTrades: result.totalCompletedTrades,
          profitableWindows: result.profitableWindows,
          unprofitableWindows: result.unprofitableWindows,
          flatWindows: result.flatWindows,
          aggregatePnl: result.aggregatePnl,
          synthetic,
          note: result.note,
        }
      : {
          ...result.metrics,
          synthetic,
        };

    return updateExperiment(id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      datasetIdentity: result.seriesIdentity || experiment.datasetIdentity,
      metrics,
      datasetReportSummary: summarizeReport(result.datasetReport),
      evaluation: {
        method,
        seriesCount: result.seriesCount,
        startTs: result.startTs || null,
        endTs: result.endTs || null,
        outOfSample: method === 'walk-forward',
        synthetic,
        note: 'Historical evaluation only. Not a claim of future performance.',
      },
    });
  } catch (err) {
    return updateExperiment(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: err.message,
      metrics: null,
    });
  }
}
