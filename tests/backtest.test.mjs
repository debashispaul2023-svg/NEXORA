import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';
import { validateHistoricalSeries } from '../src/backtest/input.mjs';
import { BacktestEngine } from '../src/backtest/engine.mjs';
import { buildBacktestMetrics } from '../src/backtest/metrics.mjs';
import { saveBacktestRun, loadBacktestRun } from '../src/backtest/store.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { MarketDataError } from '../src/errors.mjs';

const candles = generateSyntheticSeries({ count: 20, startPrice: 100, startTs: Date.UTC(2026, 0, 15) });

function cleanRun(runId) {
  if (!runId) return;
  const p = resolveProjectPath(`data/backtests/${runId}.json`);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

test('historical series validation rejects empty and duplicates', () => {
  assert.throws(() => validateHistoricalSeries([]), MarketDataError);
  const bad = [
    { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
  ];
  assert.throws(() => validateHistoricalSeries(bad), MarketDataError);
});

test('historical series identity is stable', () => {
  const a = validateHistoricalSeries(candles);
  const b = validateHistoricalSeries(candles);
  assert.equal(a.identity, b.identity);
  assert.equal(a.count, candles.length);
});

test('backtest processes candles chronologically and produces metrics', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles);
  assert.ok(result.runId);
  assert.equal(result.seriesCount, candles.length);
  assert.equal(result.metrics.startingCapital, 1000);
  assert.ok(Number.isFinite(result.metrics.endingEquity));
  assert.equal(result.metrics.strategyRealizedPnl, null);
  assert.ok(result.signals.length === candles.length);
});

test('repeated runs produce identical financial results', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, slippageBps: 5, audit: false });
  const a = await engine.run(candles);
  const b = await engine.run(candles);
  assert.equal(a.metrics.endingCash, b.metrics.endingCash);
  assert.equal(a.metrics.endingPositionQty, b.metrics.endingPositionQty);
  assert.equal(a.metrics.endingEquity, b.metrics.endingEquity);
  assert.equal(a.metrics.realizedPnl, b.metrics.realizedPnl);
  assert.notEqual(a.runId, b.runId);
});

test('prefix evaluation is causal: shorter series does not see future candles', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const full = await engine.run(candles);
  const prefix = candles.slice(0, 10);
  const short = await engine.run(prefix);
  // Signals on the common prefix must match
  for (let i = 0; i < prefix.length; i++) {
    assert.equal(short.signals[i].signal, full.signals[i].signal);
  }
});

test('risk rejection leaves capital unchanged for oversized order', async () => {
  const engine = new BacktestEngine({
    initialCapital: 1000,
    riskLimits: { maxOrderNotional: 1 },
    audit: false,
  });
  const result = await engine.run(candles);
  assert.equal(result.metrics.endingCash, 1000);
  assert.equal(result.metrics.endingPositionQty, 0);
});

test('final open position is valued at final mark', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles);
  if (result.metrics.endingPositionQty > 0) {
    assert.equal(result.metrics.equityMode, 'mark_to_market');
    const expected = result.metrics.endingCash + result.metrics.endingPositionQty * candles[candles.length - 1].close;
    assert.ok(Math.abs(result.metrics.endingEquity - expected) < 1e-6);
  }
});

test('max drawdown is null or a non-negative fraction', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles);
  const dd = result.metrics.maxDrawdown;
  assert.ok(dd === null || (dd >= 0 && dd <= 1));
});

test('run records are not overwritten', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles);
  const saved = saveBacktestRun(result);
  assert.equal(saved.saved, true);
  const loaded = loadBacktestRun(result.runId);
  assert.equal(loaded.runId, result.runId);
  assert.throws(() => saveBacktestRun(result));
  cleanRun(result.runId);
});

test('metrics do not invent strategy-level P&L', () => {
  const m = buildBacktestMetrics({
    initialCapital: 1000,
    ledgerSnapshot: { cash: 900, positionQty: 1, avgEntry: 100, realizedPnl: 0 },
    ledgerEntries: [],
    finalMark: 110,
  });
  assert.equal(m.strategyRealizedPnl, null);
  assert.equal(m.equityMode, 'mark_to_market');
  assert.ok(Math.abs(m.unrealizedPnl - 10) < 1e-9);
});

test('invalid candles are rejected by historical input', () => {
  assert.throws(() => validateHistoricalSeries([{ timestamp: 'bad' }]), MarketDataError);
});
