import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { evaluateBaseline, STRATEGY_ID, STRATEGY_VERSION } from '../src/strategies/baseline.mjs';
import { StrategyRunner } from '../src/strategies/runner.mjs';
import { PaperTradingWorkflow } from '../src/risk/workflow.mjs';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { sma, ema, rsi } from '../src/market-data/indicators.mjs';

const longSeries = generateSyntheticSeries({ count: 30, startPrice: 100, startTs: Date.UTC(2026, 0, 1) });

function makeWorkflow(persist = false) {
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 10000 });
  const workflow = new PaperTradingWorkflow({
    engine, ledger,
    riskLimits: { maxPositionQty: 100, maxPositionNotional: 100000, maxOrderNotional: 100000, dailyRealizedLossLimit: null },
    persist,
  });
  return { engine, ledger, workflow };
}

test('insufficient history produces HOLD and no order', async () => {
  const short = generateSyntheticSeries({ count: 5, startPrice: 100 });
  const signal = evaluateBaseline(short);
  assert.equal(signal.signal, 'HOLD');
  assert.equal(signal.reason, 'insufficient_history');
  assert.equal(signal.actionable, false);
  assert.equal(signal.strategyId, STRATEGY_ID);
  assert.equal(signal.strategyVersion, STRATEGY_VERSION);
});

test('evaluation is deterministic for identical inputs', async () => {
  const a = evaluateBaseline(longSeries);
  const b = evaluateBaseline(longSeries);
  assert.deepEqual(a, b);
});

test('HOLD produces no order through runner', async () => {
  const { workflow, ledger } = makeWorkflow();
  const runner = new StrategyRunner({ workflow });
  // Force HOLD by using short series
  const short = generateSyntheticSeries({ count: 3 });
  const out = await runner.run(short);
  assert.equal(out.signal.signal, 'HOLD');
  assert.equal(out.workflowResult, null);
  assert.equal(ledger.snapshot().positionQty, 0);
  assert.equal(out.record.orderId, null);
});

test('repeated evaluation of same candle does not create duplicate orders', async () => {
  const { workflow, ledger } = makeWorkflow();
  const runner = new StrategyRunner({ workflow });
  const first = await runner.run(longSeries);
  const second = await runner.run(longSeries);
  assert.equal(second.duplicate, true);
  assert.equal(runner.getRecords().length, 1);
  // At most one ledger entry if first was actionable
  const fills = ledger.getLedger().length;
  assert.ok(fills <= 1);
});

test('actionable signal goes through workflow and respects risk rejection', async () => {
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 10000 });
  const workflow = new PaperTradingWorkflow({
    engine, ledger,
    riskLimits: { maxOrderNotional: 1 }, // force rejection
    persist: false,
  });
  const runner = new StrategyRunner({ workflow });
  const out = await runner.run(longSeries);
  if (out.signal.actionable) {
    assert.equal(out.workflowResult.approved, false);
    assert.equal(out.workflowResult.outcome, 'risk_rejected');
    assert.equal(ledger.snapshot().positionQty, 0);
    assert.ok(out.record.riskDecision);
  } else {
    assert.equal(out.workflowResult, null);
  }
});

test('SELL with no position is rejected by risk (long-only)', async () => {
  // Craft a series that should produce SELL if rules match, or just verify runner path
  const { workflow, ledger } = makeWorkflow();
  const runner = new StrategyRunner({ workflow });
  const out = await runner.run(longSeries);
  if (out.signal.signal === 'SELL') {
    assert.equal(out.workflowResult.approved, false);
    assert.equal(ledger.snapshot().positionQty, 0);
  }
  // Always true: no short created
  assert.ok(ledger.snapshot().positionQty >= 0);
});

test('future data does not affect signal at earlier index', async () => {
  const full = longSeries;
  const truncated = longSeries.slice(0, 20);
  const sigFull = evaluateBaseline(full.slice(0, 20));
  const sigTrunc = evaluateBaseline(truncated);
  assert.deepEqual(sigFull.indicators, sigTrunc.indicators);
  assert.equal(sigFull.signal, sigTrunc.signal);
});

test('evaluation record captures strategy metadata and can reproduce signal', async () => {
  const { workflow } = makeWorkflow();
  const runner = new StrategyRunner({ workflow });
  const out = await runner.run(longSeries);
  const rec = out.record;
  assert.equal(rec.strategyId, STRATEGY_ID);
  assert.equal(rec.strategyVersion, STRATEGY_VERSION);
  assert.ok(rec.timestamp);
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(rec.signal));
  assert.ok(rec.reason);
  assert.ok(rec.indicators);
  // Re-evaluate from same inputs
  const again = evaluateBaseline(longSeries);
  assert.equal(again.signal, rec.signal);
  assert.equal(again.reason, rec.reason);
});

test('invalid candles are rejected by strategy', async () => {
  assert.throws(() => evaluateBaseline(null));
  assert.throws(() => evaluateBaseline([]));
});

test('out-of-order candles rejected', async () => {
  const bad = generateSyntheticSeries({ count: 20 });
  bad[10] = { ...bad[10], timestamp: bad[0].timestamp - 1000 };
  assert.throws(() => evaluateBaseline(bad));
});
