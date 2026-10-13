import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';
import {
  appendEvaluation,
  loadEvaluations,
  validateEvaluationRecord,
  evaluationKey,
  EVAL_FILENAME,
  EVAL_BAK,
  EVAL_TMP,
} from '../src/analytics/records.mjs';
import {
  summarizeSignals,
  summarizeTradesFromLedger,
  maxDrawdown,
  performanceReport,
} from '../src/analytics/performance.mjs';
import { scoreDirectionalPredictions } from '../src/analytics/prediction.mjs';
import { makeEvaluationRecord } from '../src/strategies/interface.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { PaperTradingWorkflow } from '../src/risk/workflow.mjs';
import { StrategyRunner } from '../src/strategies/runner.mjs';
import { AnalyticsError } from '../src/errors.mjs';

function cleanEvals() {
  for (const n of [EVAL_FILENAME, EVAL_BAK, EVAL_TMP]) {
    const p = resolveProjectPath(`data/episodes/${n}`);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function sampleRecord(overrides = {}) {
  return makeEvaluationRecord({
    strategyId: 'baseline-sma-ema-rsi',
    strategyVersion: '1.0.0',
    timestamp: 1_700_000_000_000,
    candleTimestamp: 1_700_000_000_000,
    signal: 'BUY',
    reason: 'test',
    indicators: { sma: 100, ema: 101, rsi: 40 },
    orderId: 'baseline-sma-ema-rsi-1700000000000',
    riskDecision: { approved: true },
    executionOutcome: { approved: true, durable: true, outcome: 'committed' },
    ...overrides,
  });
}

test('append and load evaluation records round-trip', async () => {
  cleanEvals();
  const r = sampleRecord();
  const result = appendEvaluation(r);
  assert.equal(result.appended, true);
  const store = loadEvaluations();
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].strategyId, r.strategyId);
  assert.equal(store.records[0].signal, 'BUY');
  cleanEvals();
});

test('duplicate evaluation key is not appended twice', async () => {
  cleanEvals();
  const r = sampleRecord();
  assert.equal(appendEvaluation(r).appended, true);
  assert.equal(appendEvaluation(r).appended, false);
  assert.equal(loadEvaluations().records.length, 1);
  cleanEvals();
});

test('schema validation rejects invalid records', async () => {
  assert.throws(() => validateEvaluationRecord({}), AnalyticsError);
  assert.throws(() => validateEvaluationRecord({ strategyId: 'x', strategyVersion: '1', timestamp: 1, candleTimestamp: 1, signal: 'MAYBE', reason: 'x' }), AnalyticsError);
});

test('corrupt evaluations file is handled safely', async () => {
  cleanEvals();
  const path = resolveProjectPath(`data/episodes/${EVAL_FILENAME}`);
  writeFileSync(path, '{ not valid json');
  const store = loadEvaluations();
  assert.ok(Array.isArray(store.records));
  assert.equal(store.records.length, 0);
  cleanEvals();
});

test('unsupported schema version is rejected', async () => {
  cleanEvals();
  const path = resolveProjectPath(`data/episodes/${EVAL_FILENAME}`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 99, records: [] }));
  const store = loadEvaluations();
  assert.equal(store.records.length, 0);
  cleanEvals();
});

test('signal summary counts are correct', async () => {
  const records = [
    sampleRecord({ signal: 'BUY', orderId: 'a', executionOutcome: { approved: true } }),
    sampleRecord({ signal: 'SELL', candleTimestamp: 2, timestamp: 2, orderId: 'b', executionOutcome: { approved: false } }),
    sampleRecord({ signal: 'HOLD', candleTimestamp: 3, timestamp: 3, orderId: null, executionOutcome: null }),
  ];
  const s = summarizeSignals(records);
  assert.equal(s.totalSignals, 3);
  assert.equal(s.actionableSignals, 2);
  assert.equal(s.holdSignals, 1);
  assert.equal(s.submittedOrders, 2);
  assert.equal(s.acceptedOrders, 1);
  assert.equal(s.rejectedOrders, 1);
});

test('win rate excludes open positions and uses completed sells', async () => {
  const entries = [
    { side: 'BUY', quantity: 1, price: 100, feeCents: 0, realizedPnlCents: 0, timestamp: 1 },
    { side: 'SELL', quantity: 1, price: 110, feeCents: 10, realizedPnlCents: 1000, timestamp: 2 },
    { side: 'BUY', quantity: 1, price: 100, feeCents: 0, realizedPnlCents: 1000, timestamp: 3 },
  ];
  const t = summarizeTradesFromLedger(entries);
  assert.equal(t.completedTrades, 1);
  assert.equal(t.winningTrades, 1);
  assert.equal(t.losingTrades, 0);
  assert.equal(t.winRate, 1);
  assert.equal(t.totalFees, 0.1);
  // Open BUY after SELL is not a completed trade
});

test('max drawdown from equity series', async () => {
  const series = [
    { timestamp: 1, equity: 100 },
    { timestamp: 2, equity: 120 },
    { timestamp: 3, equity: 90 },
    { timestamp: 4, equity: 110 },
  ];
  const dd = maxDrawdown(series);
  assert.ok(Math.abs(dd - 0.25) < 1e-9); // 120 → 90 = 25%
});

test('performance report marks unavailable metrics as null when data missing', async () => {
  const report = performanceReport({ records: [], ledgerSnapshot: null });
  assert.equal(report.realizedPnl, null);
  assert.equal(report.unrealizedPnl, null);
  assert.equal(report.winRate, null);
  assert.equal(report.maxDrawdown, null);
});

test('prediction scoring does not use future data for unresolved predictions', async () => {
  const candles = generateSyntheticSeries({ count: 5, startPrice: 100 });
  const records = [
    sampleRecord({
      signal: 'BUY',
      candleTimestamp: candles[4].timestamp,
      timestamp: candles[4].timestamp,
    }),
  ];
  // Horizon 1 from last candle is unresolved
  const score = scoreDirectionalPredictions(records, candles, 1);
  assert.equal(score.unresolved, 1);
  assert.equal(score.scored, 0);
  assert.equal(score.directionalAccuracy, null);
});

test('prediction scoring is causal: earlier prediction scored only with later candles', async () => {
  const candles = generateSyntheticSeries({ count: 10, startPrice: 100 });
  const records = [
    sampleRecord({
      signal: 'BUY',
      candleTimestamp: candles[2].timestamp,
      timestamp: candles[2].timestamp,
    }),
  ];
  const score = scoreDirectionalPredictions(records, candles, 1);
  assert.equal(score.unresolved, 0);
  assert.equal(score.scored, 1);
  assert.ok(['correct', 'incorrect', 'flat'].includes(score.details[0].status));
});

test('runner can persist evaluation records', async () => {
  cleanEvals();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 10000 });
  const workflow = new PaperTradingWorkflow({
    engine,
    ledger,
    riskLimits: { maxPositionQty: 100, maxPositionNotional: 100000, maxOrderNotional: 100000, dailyRealizedLossLimit: null },
    persist: false,
  });
  const runner = new StrategyRunner({ workflow, persistRecords: true });
  const series = generateSyntheticSeries({ count: 25, startPrice: 100 });
  const out = await runner.run(series);
  assert.equal(out.duplicate, false);
  const store = loadEvaluations();
  assert.ok(store.records.length >= 1);
  // Second run is duplicate
  const out2 = await runner.run(series);
  assert.equal(out2.duplicate, true);
  assert.equal(loadEvaluations().records.length, store.records.length);
  cleanEvals();
});

test('evaluation key is deterministic', async () => {
  const r = sampleRecord();
  assert.equal(evaluationKey(r), `${r.strategyId}:${r.candleTimestamp}`);
});
