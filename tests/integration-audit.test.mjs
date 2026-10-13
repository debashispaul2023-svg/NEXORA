import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { PaperTradingWorkflow } from '../src/risk/workflow.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { loadEvents } from '../src/audit/events.mjs';
import { loadEquitySnapshots } from '../src/audit/equity.mjs';
import { reconcileAudit } from '../src/audit/reconcile.mjs';

const candles = generateSyntheticSeries({ count: 5, startPrice: 100, startTs: Date.UTC(2026, 0, 15) });

function clean() {
  for (const n of ['events.jsonl', 'equity.jsonl']) {
    const p = resolveProjectPath(`data/audit/${n}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
  for (const n of ['paper-state.json', 'paper-state.json.bak', 'paper-state.json.tmp']) {
    const p = resolveProjectPath(`data/trades/${n}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

function makeWf(opts = {}) {
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const workflow = new PaperTradingWorkflow({
    engine,
    ledger,
    riskLimits: { maxPositionQty: 100, maxPositionNotional: 100000, maxOrderNotional: 100000, dailyRealizedLossLimit: null },
    persist: false,
    audit: true,
    ...opts,
  });
  return { engine, ledger, workflow };
}

test('accepted order emits submitted, approved, filled, accounting events', async () => {
  clean();
  const { workflow, ledger } = makeWf();
  const r = await workflow.submitOrder({ id: 'life-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, true);
  assert.equal(r.outcome, 'memory_only');
  assert.ok(r.correlationId);
  const events = loadEvents().events.map((e) => e.eventType);
  assert.ok(events.includes('ORDER_SUBMITTED'));
  assert.ok(events.includes('ORDER_APPROVED'));
  assert.ok(events.includes('ORDER_FILLED'));
  assert.ok(events.includes('ACCOUNTING_APPLIED'));
  assert.equal(ledger.snapshot().positionQty, 1);
  clean();
});

test('risk-rejected order emits submitted and rejected with risk stage', async () => {
  clean();
  const { workflow, ledger } = makeWf({ riskLimits: { maxOrderNotional: 1 } });
  const r = await workflow.submitOrder({ id: 'rej-1', type: 'MARKET', side: 'BUY', quantity: 10, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, false);
  assert.equal(r.outcome, 'risk_rejected');
  const events = loadEvents().events;
  const rejected = events.find((e) => e.eventType === 'ORDER_REJECTED');
  assert.ok(rejected);
  assert.equal(rejected.payload.stage, 'risk');
  assert.ok(!events.some((e) => e.eventType === 'ORDER_FILLED'));
  assert.ok(!events.some((e) => e.eventType === 'ACCOUNTING_APPLIED'));
  assert.equal(ledger.snapshot().positionQty, 0);
  clean();
});

test('duplicate order submission does not double-account', async () => {
  clean();
  const { workflow, ledger } = makeWf();
  await workflow.submitOrder({ id: 'dup-life', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  await workflow.submitOrder({ id: 'dup-life', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(ledger.snapshot().positionQty, 1);
  assert.equal(ledger.getLedger().length, 1);
  clean();
});

test('audit append failure after accounting reports degraded but keeps commit', async () => {
  clean();
  const { workflow, ledger } = makeWf({
    appendEventFn: async () => {
      throw new Error('audit disk full');
    },
  });
  const r = await workflow.submitOrder({ id: 'aud-fail', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.approved, true);
  assert.equal(r.auditDegraded, true);
  assert.ok(r.auditFailures.length > 0);
  assert.equal(ledger.snapshot().positionQty, 1);
  clean();
});

test('portfolio persistence failure rolls back and emits TRANSACTION_ROLLED_BACK', async () => {
  clean();
  const { workflow, ledger } = makeWf({
    persist: true,
    persistFn: () => {
      throw new Error('persist failed');
    },
  });
  const before = ledger.snapshot();
  const r = await workflow.submitOrder({ id: 'pers-fail', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(r.outcome, 'rolled_back');
  assert.equal(r.durable, false);
  assert.deepEqual(ledger.snapshot(), before);
  const events = loadEvents().events;
  assert.ok(events.some((e) => e.eventType === 'TRANSACTION_ROLLED_BACK'));
  assert.ok(!events.some((e) => e.eventType === 'ORDER_REJECTED' && e.payload?.stage === 'risk'));
  clean();
});

test('equity snapshot recorded after successful accounting', async () => {
  clean();
  const { workflow } = makeWf({ markPrice: 100 });
  await workflow.submitOrder({ id: 'eq-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  const snaps = loadEquitySnapshots().snapshots;
  assert.ok(snaps.length >= 1);
  assert.equal(snaps[0].mode, 'mark_to_market');
  clean();
});

test('cash-only equity when no mark price', async () => {
  clean();
  const { workflow } = makeWf();
  await workflow.submitOrder({ id: 'eq-cash', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  const snaps = loadEquitySnapshots().snapshots;
  assert.ok(snaps.length >= 1);
  assert.equal(snaps[0].mode, 'cash_only');
  clean();
});

test('reconciliation distinguishes filled from missing accounting', async () => {
  clean();
  const { workflow } = makeWf();
  await workflow.submitOrder({ id: 'rec-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  const report = reconcileAudit({ portfolioSnapshot: workflow.ledger.snapshot() });
  assert.ok(report.totalEvents >= 4);
  assert.equal(report.fillsWithoutAccountingEvent.length, 0);
  assert.equal(report.portfolioProvided, true);
  clean();
});

test('correlation id is stable across events for one order', async () => {
  clean();
  const { workflow } = makeWf();
  await workflow.submitOrder({ id: 'corr-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  const events = loadEvents().events;
  const ids = new Set(events.map((e) => e.correlationId));
  assert.equal(ids.size, 1);
  assert.ok(ids.has('corr-1'));
  clean();
});

test('concurrent distinct orders do not corrupt accounting', async () => {
  clean();
  const { workflow, ledger } = makeWf();
  await Promise.all([
    workflow.submitOrder({ id: 'c1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles),
    workflow.submitOrder({ id: 'c2', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[1].timestamp }, candles),
  ]);
  assert.equal(ledger.snapshot().positionQty, 2);
  assert.equal(ledger.getLedger().length, 2);
  clean();
});

test('strategy-level realized P&L is explicitly unavailable', async () => {
  const { performanceReport } = await import('../src/analytics/performance.mjs');
  const report = performanceReport({ records: [], ledgerSnapshot: { cash: 1000, positionQty: 0, realizedPnl: 5 } });
  assert.equal(report.strategyRealizedPnl, null);
  assert.equal(report.realizedPnl, 5);
});
