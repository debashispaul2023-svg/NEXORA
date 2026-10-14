import { PaperExecutionEngine } from '../execution/engine.mjs';
import { AccountingLedger } from '../accounting/ledger.mjs';
import { PaperTradingWorkflow } from '../risk/workflow.mjs';
import { StrategyRunner } from '../strategies/runner.mjs';
import { evaluateBaseline, STRATEGY_ID, STRATEGY_VERSION } from '../strategies/baseline.mjs';
import { validateHistoricalSeries } from './input.mjs';
import { buildBacktestMetrics } from './metrics.mjs';
import { buildDatasetReport } from '../market-data/dataset.mjs';
import { randomUUID } from 'node:crypto';

/**
 * Deterministic historical backtesting engine.
 *
 * Causality:
 * - Candles are processed in chronological order.
 * - At index i the strategy sees only candles[0..i] (prefix).
 * - Order timestamp = candle i timestamp.
 * - Fill uses the existing engine: first candle with timestamp >= order timestamp,
 *   fill at that candle's close adjusted by slippage. Never uses future highs/lows.
 * - A signal using candle t's close can fill at candle t's close (end-of-bar model)
 *   or later; it cannot fill on a candle before t.
 *
 * Isolation:
 * - Each run gets a fresh engine, ledger, workflow, and runner.
 * - Unique runId. Prior runs cannot contaminate a new run.
 */

export class BacktestEngine {
  /**
   * @param {object} opts
   * @param {function} [opts.evaluate]
   * @param {object} [opts.riskLimits]
   * @param {number} [opts.slippageBps=0]
   * @param {number} [opts.initialCapital=1000]
   * @param {boolean} [opts.audit=false] - audit off by default for isolated runs
   */
  constructor({
    evaluate = evaluateBaseline,
    riskLimits = {},
    slippageBps = 0,
    initialCapital = 1000,
    audit = false,
  } = {}) {
    this.evaluate = evaluate;
    this.riskLimits = riskLimits;
    this.slippageBps = slippageBps;
    this.initialCapital = initialCapital;
    this.audit = audit;
  }

  /**
   * Run a backtest on a historical series.
   * @param {object[]} candles
   * @param {object} [params] - strategy params
   * @param {object} [runOpts]
   * @param {number} [runOpts.expectedIntervalMs] - opt-in gap warning interval
   * @returns {object} run result
   */
  async run(candles, params = {}, runOpts = {}) {
    const validated = validateHistoricalSeries(candles);
    const runId = randomUUID();
    const series = validated.series;
    const datasetReport = buildDatasetReport(series, {
      expectedIntervalMs: runOpts.expectedIntervalMs,
    });

    const engine = new PaperExecutionEngine({ slippageBps: this.slippageBps });
    const ledger = new AccountingLedger({ initialCapital: this.initialCapital });
    const workflow = new PaperTradingWorkflow({
      engine,
      ledger,
      riskLimits: this.riskLimits,
      persist: false,
      audit: this.audit,
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
    });
    const runner = new StrategyRunner({
      workflow,
      evaluate: this.evaluate,
      persistRecords: false,
      audit: this.audit,
    });

    const equitySeries = [];
    const signals = [];

    for (let i = 0; i < series.length; i++) {
      const prefix = series.slice(0, i + 1);
      const result = await runner.run(prefix, params);
      signals.push({
        timestamp: series[i].timestamp,
        signal: result.signal.signal,
        actionable: result.signal.actionable,
        orderId: result.record?.orderId || null,
        outcome: result.workflowResult?.outcome || null,
      });

      const snap = ledger.snapshot();
      const mark = series[i].close;
      const equity = snap.cash + snap.positionQty * mark;
      equitySeries.push({ timestamp: series[i].timestamp, equity, cash: snap.cash, positionQty: snap.positionQty });
    }

    const finalSnap = ledger.snapshot();
    const finalMark = series[series.length - 1].close;
    const metrics = buildBacktestMetrics({
      initialCapital: this.initialCapital,
      ledgerSnapshot: finalSnap,
      ledgerEntries: ledger.getLedger(),
      finalMark,
      equitySeries,
      signals,
    });

    return {
      runId,
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      seriesIdentity: validated.identity,
      seriesCount: validated.count,
      startTs: validated.startTs,
      endTs: validated.endTs,
      config: {
        initialCapital: this.initialCapital,
        slippageBps: this.slippageBps,
        riskLimits: this.riskLimits,
        params,
      },
      signals,
      metrics,
      finalSnapshot: finalSnap,
      datasetReport,
    };
  }
}
