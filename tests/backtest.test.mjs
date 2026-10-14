import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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

test('unsafe runId is rejected', () => {
  assert.throws(() => saveBacktestRun({ runId: '../escape' }), /runId/);
  assert.throws(() => saveBacktestRun({ runId: 'a/b' }), /runId/);
  assert.throws(() => loadBacktestRun('../escape'), /runId/);
});

test('invalid candles are rejected by historical input', () => {
  assert.throws(() => validateHistoricalSeries([{ timestamp: 'bad' }]), MarketDataError);
});

test('out-of-order and non-finite candles are rejected', () => {
  const base = { open: 10, high: 11, low: 9, close: 10, volume: 1 };
  assert.throws(
    () => validateHistoricalSeries([
      { ...base, timestamp: 2000 },
      { ...base, timestamp: 1000 },
    ]),
    MarketDataError,
  );
  assert.throws(
    () => validateHistoricalSeries([{ ...base, timestamp: 1000, close: NaN }]),
    MarketDataError,
  );
  assert.throws(
    () => validateHistoricalSeries([{ ...base, timestamp: 1000, high: 8 }]),
    MarketDataError,
  );
});

test('evaluate receives only the chronological prefix', async () => {
  const seen = [];
  const evaluate = (series) => {
    seen.push(series.length);
    const last = series[series.length - 1];
    return {
      strategyId: 'probe',
      strategyVersion: '1',
      timestamp: last.timestamp,
      signal: 'HOLD',
      reason: 'probe',
      actionable: false,
      indicators: { close: last.close },
    };
  };
  const engine = new BacktestEngine({ evaluate, initialCapital: 1000, audit: false });
  const short = candles.slice(0, 5);
  await engine.run(short);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('end-of-bar fill uses signal candle close and not a future high', async () => {
  const series = [
    { timestamp: 1000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { timestamp: 2000, open: 100, high: 150, low: 99, close: 110, volume: 1 },
  ];
  const evaluate = (s) => {
    const last = s[s.length - 1];
    if (last.timestamp !== 2000) {
      return { strategyId: 'probe', strategyVersion: '1', timestamp: last.timestamp, signal: 'HOLD', reason: 'wait', actionable: false, indicators: {} };
    }
    return { strategyId: 'probe', strategyVersion: '1', timestamp: last.timestamp, signal: 'BUY', reason: 'buy', actionable: true, quantity: 1, indicators: { close: last.close } };
  };
  const engine = new BacktestEngine({ evaluate, initialCapital: 1000, slippageBps: 0, audit: false });
  const result = await engine.run(series);
  assert.equal(result.metrics.endingPositionQty, 1);
  // Fill at close 110, not high 150
  assert.ok(Math.abs(result.metrics.endingCash - 890) < 1e-6);
  const buy = result.signals.find((s) => s.signal === 'BUY');
  assert.equal(buy.timestamp, 2000);
});

test('win rate is null when no completed trades', () => {
  const m = buildBacktestMetrics({
    initialCapital: 1000,
    ledgerSnapshot: { cash: 1000, positionQty: 0, avgEntry: 0, realizedPnl: 0 },
    ledgerEntries: [],
    finalMark: 100,
  });
  assert.equal(m.completedTrades, 0);
  assert.equal(m.winRate, null);
});

test('missing final mark yields cash-only equity', () => {
  const m = buildBacktestMetrics({
    initialCapital: 1000,
    ledgerSnapshot: { cash: 900, positionQty: 1, avgEntry: 100, realizedPnl: 0 },
    ledgerEntries: [],
    finalMark: null,
  });
  assert.equal(m.equityMode, 'cash_only');
  assert.equal(m.endingEquity, 900);
  assert.equal(m.unrealizedPnl, null);
});

test('drawdown is null for a single equity point', () => {
  const m = buildBacktestMetrics({
    initialCapital: 1000,
    ledgerSnapshot: { cash: 1000, positionQty: 0, avgEntry: 0, realizedPnl: 0 },
    equitySeries: [{ timestamp: 1, equity: 1000 }],
  });
  assert.equal(m.maxDrawdown, null);
});

test('independent runs do not share capital', async () => {
  const a = new BacktestEngine({ initialCapital: 1000, audit: false });
  const b = new BacktestEngine({ initialCapital: 500, audit: false });
  const ra = await a.run(candles);
  const rb = await b.run(candles);
  assert.equal(ra.metrics.startingCapital, 1000);
  assert.equal(rb.metrics.startingCapital, 500);
  assert.notEqual(ra.runId, rb.runId);
});

test('saved run has schema version and does not alter paper state', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles.slice(0, 8));
  saveBacktestRun(result);
  const loaded = loadBacktestRun(result.runId);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.seriesIdentity, result.seriesIdentity);
  const paper = resolveProjectPath('data/trades/paper-state.json');
  assert.equal(existsSync(paper), false);
  cleanRun(result.runId);
});

test('successful backtest includes an OK dataset report', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const result = await engine.run(candles);
  assert.equal(result.datasetReport.ok, true);
  assert.equal(result.datasetReport.errorCount, 0);
  assert.equal(result.metrics.startingCapital, 1000);
});

test('invalid series still throws before a result is returned', async () => {
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  await assert.rejects(() => engine.run([{ timestamp: 'bad' }]), MarketDataError);
});

test('gap warning appears only with expectedIntervalMs and does not fail the run', async () => {
  const gapped = [
    candles[0],
    { ...candles[1], timestamp: candles[0].timestamp + 180_000 },
  ];
  const engine = new BacktestEngine({ initialCapital: 1000, audit: false });
  const plain = await engine.run(gapped);
  assert.equal(plain.datasetReport.issues.filter((i) => i.code === 'TIME_GAP').length, 0);
  assert.ok(Number.isFinite(plain.metrics.endingEquity));

  const warned = await engine.run(gapped, {}, { expectedIntervalMs: 60_000 });
  assert.equal(warned.datasetReport.ok, true);
  assert.ok(warned.datasetReport.issues.some((i) => i.code === 'TIME_GAP' && i.severity === 'warning'));
  assert.ok(Number.isFinite(warned.metrics.endingEquity));
});

test('legacy persisted records without datasetReport remain readable', () => {
  const runId = 'legacy-no-report';
  const path = resolveProjectPath(`data/backtests/${runId}.json`);
  mkdirSync(resolveProjectPath('data/backtests'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    runId,
    seriesIdentity: 'abc',
    metrics: { startingCapital: 1000 },
  }), 'utf8');
  const loaded = loadBacktestRun(runId);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.datasetReport, undefined);
  assert.equal(loaded.metrics.startingCapital, 1000);
  cleanRun(runId);
});
