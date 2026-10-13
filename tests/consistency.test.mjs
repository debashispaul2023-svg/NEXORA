import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { PaperTradingWorkflow } from '../src/risk/workflow.mjs';
import { saveSnapshot, loadSnapshot } from '../src/persistence/store.mjs';
import { resolveProjectPath } from '../src/paths.mjs';
import { unlinkSync, existsSync } from 'node:fs';

const candles = generateSyntheticSeries({ count: 5, startPrice: 100, startTs: Date.UTC(2026, 0, 15) });

function clean() {
  for (const n of ['paper-state.json', 'paper-state.json.bak', 'paper-state.json.tmp']) {
    const p = resolveProjectPath(`data/trades/${n}`);
    if (existsSync(p)) try { unlinkSync(p); } catch { /* */ }
  }
}

test('persistence failure rolls back in-memory state', async () => {
  clean();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const failingPersist = () => { throw new Error('disk full'); };
  const wf = new PaperTradingWorkflow({ engine, ledger, persist: true, persistFn: failingPersist });

  const before = ledger.snapshot();
  const r = await wf.submitOrder({ id: 'fail1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);

  assert.equal(r.approved, false);
  assert.equal(r.durable, false);
  assert.equal(r.outcome, 'rolled_back');
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal(ledger.getLedger().length, 0);
  assert.equal(engine.getOrder('fail1'), null);
  clean();
});

test('retry after rollback succeeds and is idempotent', async () => {
  clean();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  let fail = true;
  const flaky = (eng, led, extra) => {
    if (fail) throw new Error('transient');
    return saveSnapshot(eng, led, extra);
  };
  const wf = new PaperTradingWorkflow({ engine, ledger, persist: true, persistFn: flaky });

  const r1 = await wf.submitOrder({ id: 'retry1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r1.outcome, 'rolled_back');
  assert.equal(ledger.snapshot().positionQty, 0);

  fail = false;
  const r2 = await wf.submitOrder({ id: 'retry1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r2.approved, true);
  assert.equal(r2.durable, true);
  assert.equal(ledger.snapshot().positionQty, 1);
  assert.equal(ledger.getLedger().length, 1);

  // Second success does not double-apply
  const r3 = await wf.submitOrder({ id: 'retry1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(ledger.getLedger().length, 1);
  clean();
});

test('successful persist reports durable committed', async () => {
  clean();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const wf = new PaperTradingWorkflow({ engine, ledger, persist: true });
  const r = await wf.submitOrder({ id: 'ok-dur', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, true);
  assert.equal(r.durable, true);
  assert.equal(r.outcome, 'committed');
  const rec = loadSnapshot();
  assert.ok(rec);
  assert.equal(rec.ledger.snapshot().positionQty, 1);
  clean();
});

test('risk rejection never mutates or persists', async () => {
  clean();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const wf = new PaperTradingWorkflow({
    engine, ledger,
    riskLimits: { maxOrderNotional: 1 },
    persist: true,
  });
  const before = ledger.snapshot();
  const r = await wf.submitOrder({ id: 'riskrej', type: 'MARKET', side: 'BUY', quantity: 10, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, false);
  assert.equal(r.outcome, 'risk_rejected');
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal(loadSnapshot(), null);
  clean();
});

test('memory-only mode reports durable false', async () => {
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const wf = new PaperTradingWorkflow({ engine, ledger, persist: false });
  const r = await wf.submitOrder({ id: 'mem', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, true);
  assert.equal(r.durable, false);
  assert.equal(r.outcome, 'memory_only');
  assert.equal(ledger.snapshot().positionQty, 1);
});
