import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { validateOrderIntent } from '../src/execution/order.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { ExecutionError, AccountingError } from '../src/errors.mjs';

const candles = generateSyntheticSeries({ count: 10, startPrice: 100, startTs: 1_700_000_000_000 });

test('MARKET buy fills at first candle at or after order timestamp', () => {
  const engine = new PaperExecutionEngine({ slippageBps: 0 });
  const intent = { id: 'ord-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[2].timestamp };
  const result = engine.submit(intent, candles);
  assert.equal(result.order.state, 'filled');
  assert.equal(result.fill.price, candles[2].close);
  assert.equal(result.fill.timestamp, candles[2].timestamp);
});

test('duplicate order id is idempotent and does not re-execute', () => {
  const engine = new PaperExecutionEngine();
  const intent = { id: 'dup-1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp };
  const r1 = engine.submit(intent, candles);
  const r2 = engine.submit(intent, candles);
  assert.equal(r1, r2);
  assert.equal(engine.orders.size, 1);
});

test('order before any candle is rejected', () => {
  const engine = new PaperExecutionEngine();
  const intent = { id: 'early', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[candles.length - 1].timestamp + 100000 };
  const result = engine.submit(intent, candles);
  assert.equal(result.order.state, 'rejected');
  assert.equal(result.fill, null);
});

test('unsupported order type is rejected at validation', () => {
  assert.throws(() => validateOrderIntent({ id: 'x', type: 'LIMIT', side: 'BUY', quantity: 1, timestamp: 1 }), ExecutionError);
});

test('invalid quantity rejected', () => {
  assert.throws(() => validateOrderIntent({ id: 'x', type: 'MARKET', side: 'BUY', quantity: 0, timestamp: 1 }), ExecutionError);
  assert.throws(() => validateOrderIntent({ id: 'x', type: 'MARKET', side: 'BUY', quantity: -1, timestamp: 1 }), ExecutionError);
});

test('BUY then SELL updates cash, position, realized P&L; rejected orders do not change state', () => {
  const ledger = new AccountingLedger({ initialCapital: 1000, feeBps: 0 });
  const engine = new PaperExecutionEngine({ slippageBps: 0 });

  const buyIntent = { id: 'b1', type: 'MARKET', side: 'BUY', quantity: 2, timestamp: candles[1].timestamp };
  const buyResult = engine.submit(buyIntent, candles);
  assert.equal(buyResult.order.state, 'filled');

  const afterBuy = ledger.applyFill(buyResult);
  assert.ok(afterBuy.cash < 1000);
  assert.equal(afterBuy.positionQty, 2);
  assert.ok(afterBuy.avgEntry > 0);

  // Rejected sell (too large) must not change state
  const badSell = engine.submit({ id: 'bad-sell', type: 'MARKET', side: 'SELL', quantity: 10, timestamp: candles[2].timestamp }, candles);
  // Engine will fill it (execution does not know position); accounting rejects
  assert.throws(() => ledger.applyFill(badSell), AccountingError);
  const snap = ledger.snapshot();
  assert.equal(snap.positionQty, 2);
  assert.equal(snap.ledgerLength, 1);

  // Valid sell
  const sellResult = engine.submit({ id: 's1', type: 'MARKET', side: 'SELL', quantity: 2, timestamp: candles[3].timestamp }, candles);
  const afterSell = ledger.applyFill(sellResult);
  assert.equal(afterSell.positionQty, 0);
  assert.equal(afterSell.avgEntry, 0);
  assert.ok(Number.isFinite(afterSell.realizedPnl));
});

test('insufficient cash rejects buy and leaves state unchanged', () => {
  const ledger = new AccountingLedger({ initialCapital: 10, feeBps: 0 });
  const engine = new PaperExecutionEngine();
  const buy = engine.submit({ id: 'poor', type: 'MARKET', side: 'BUY', quantity: 100, timestamp: candles[0].timestamp }, candles);
  assert.throws(() => ledger.applyFill(buy), /Insufficient cash/);
  assert.equal(ledger.snapshot().cash, 10);
  assert.equal(ledger.snapshot().positionQty, 0);
  assert.equal(ledger.getLedger().length, 0);
});

test('fees and slippage reduce proceeds / increase cost', () => {
  const engine = new PaperExecutionEngine({ slippageBps: 10 }); // 0.1%
  const buy = engine.submit({ id: 'slip', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  const raw = candles[0].close;
  assert.ok(buy.fill.price > raw);

  const ledger = new AccountingLedger({ initialCapital: 1000, feeBps: 5 });
  const before = ledger.snapshot().cash;
  ledger.applyFill(buy);
  const after = ledger.snapshot().cash;
  assert.ok(after < before - raw); // cost more than raw price due to slip + fee
});

test('equity reconciles with cash + marked position', () => {
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const engine = new PaperExecutionEngine();
  const buy = engine.submit({ id: 'eq', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);
  const mark = candles[5].close;
  const mtm = ledger.markToMarket(mark);
  const expectedEquity = mtm.cash + mtm.positionQty * mark;
  assert.ok(Math.abs(mtm.equity - expectedEquity) < 0.01);
});

test('replaying already processed fill is idempotent', () => {
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const engine = new PaperExecutionEngine();
  const buy = engine.submit({ id: 'idem', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);
  const snap1 = ledger.snapshot();
  ledger.applyFill(buy);
  const snap2 = ledger.snapshot();
  assert.deepEqual(snap1, snap2);
  assert.equal(ledger.getLedger().length, 1);
});

test('execution never uses future candles beyond the execution candle', () => {
  const engine = new PaperExecutionEngine();
  const full = candles;
  const truncated = candles.slice(0, 4);
  const intent = { id: 'causal', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[2].timestamp };
  const rFull = engine.submit(intent, full);
  const engine2 = new PaperExecutionEngine();
  const rTrunc = engine2.submit(intent, truncated);
  assert.equal(rFull.fill.price, rTrunc.fill.price);
  assert.equal(rFull.fill.timestamp, rTrunc.fill.timestamp);
});

test('cash and position invariants hold after sequence', () => {
  const ledger = new AccountingLedger({ initialCapital: 1000, feeBps: 1 });
  const engine = new PaperExecutionEngine({ slippageBps: 5 });
  const b1 = engine.submit({ id: 'inv1', type: 'MARKET', side: 'BUY', quantity: 1.5, timestamp: candles[1].timestamp }, candles);
  ledger.applyFill(b1);
  const s1 = engine.submit({ id: 'inv2', type: 'MARKET', side: 'SELL', quantity: 0.5, timestamp: candles[4].timestamp }, candles);
  ledger.applyFill(s1);
  const snap = ledger.snapshot();
  assert.ok(snap.cash >= 0);
  assert.ok(snap.positionQty >= 0);
  assert.equal(snap.positionQty, 1);
});
