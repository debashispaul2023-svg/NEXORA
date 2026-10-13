import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { MarketDataError } from '../src/errors.mjs';
import {
  validateWalkForwardConfig,
  buildWalkForwardWindows,
  runWalkForward,
} from '../src/backtest/walkforward.mjs';
import { existsSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';

const candles = generateSyntheticSeries({ count: 40, startPrice: 100, startTs: Date.UTC(2026, 0, 1) });

test('rejects invalid window configuration', () => {
  assert.throws(() => validateWalkForwardConfig({ evalBars: 0 }), MarketDataError);
  assert.throws(() => validateWalkForwardConfig({ evalBars: -1 }), MarketDataError);
  assert.throws(() => validateWalkForwardConfig({ evalBars: 5, stepBars: 0 }), MarketDataError);
  assert.throws(() => validateWalkForwardConfig({ evalBars: 1.5 }), MarketDataError);
  assert.throws(() => buildWalkForwardWindows(10, { warmupBars: 8, evalBars: 5 }), MarketDataError);
});

test('builds chronological non-overlapping windows', () => {
  const windows = buildWalkForwardWindows(20, { warmupBars: 5, evalBars: 5, stepBars: 5 });
  assert.equal(windows.length, 3);
  assert.deepEqual(windows[0], { index: 0, start: 0, warmupEnd: 5, evalEnd: 10 });
  assert.deepEqual(windows[1], { index: 1, start: 5, warmupEnd: 10, evalEnd: 15 });
  assert.ok(windows.every((w, i) => i === 0 || w.start >= windows[i - 1].evalEnd - 5));
  assert.ok(windows.every((w) => w.evalEnd > w.warmupEnd));
});

test('evaluate never sees candles past the window end', async () => {
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
      indicators: {},
    };
  };
  const result = await runWalkForward(candles.slice(0, 12), {
    warmupBars: 2,
    evalBars: 4,
    stepBars: 4,
    evaluate,
    initialCapital: 1000,
  });
  assert.equal(result.windowsSucceeded, 2);
  // Each window slice is 6 candles; engine sees lengths 1..6 twice
  assert.ok(seen.every((n) => n <= 6));
  assert.equal(Math.max(...seen), 6);
});

test('windows are independent and do not share capital', async () => {
  const result = await runWalkForward(candles, {
    warmupBars: 5,
    evalBars: 10,
    stepBars: 10,
    initialCapital: 1000,
  });
  assert.equal(result.capitalModel, 'independent_per_window');
  assert.equal(result.parameterFitting, false);
  for (const w of result.windows) {
    if (w.status === 'ok') assert.equal(w.startingCapital, 1000);
  }
  assert.ok(result.windows.length >= 2);
});

test('identical inputs produce identical financial window results', async () => {
  const opts = { warmupBars: 5, evalBars: 10, stepBars: 10, initialCapital: 1000, slippageBps: 5 };
  const a = await runWalkForward(candles, opts);
  const b = await runWalkForward(candles, opts);
  assert.equal(a.windowsSucceeded, b.windowsSucceeded);
  for (let i = 0; i < a.windows.length; i++) {
    assert.equal(a.windows[i].endingEquity, b.windows[i].endingEquity);
    assert.equal(a.windows[i].realizedPnl, b.windows[i].realizedPnl);
    assert.equal(a.windows[i].completedTrades, b.windows[i].completedTrades);
  }
});

test('win rate is null when a window has no completed trades', async () => {
  const evaluate = (series) => {
    const last = series[series.length - 1];
    return {
      strategyId: 'probe',
      strategyVersion: '1',
      timestamp: last.timestamp,
      signal: 'HOLD',
      reason: 'never',
      actionable: false,
      indicators: {},
    };
  };
  const result = await runWalkForward(candles.slice(0, 10), {
    warmupBars: 2,
    evalBars: 4,
    stepBars: 4,
    evaluate,
  });
  assert.ok(result.windows.every((w) => w.winRate === null));
  assert.equal(result.totalCompletedTrades, 0);
  assert.equal(result.sampleTooSmall, true);
});

test('malformed candles are rejected', async () => {
  await assert.rejects(
    () => runWalkForward([{ timestamp: 'bad' }], { evalBars: 1 }),
    MarketDataError,
  );
});

test('does not create paper-trading state', async () => {
  await runWalkForward(candles.slice(0, 16), { warmupBars: 4, evalBars: 4, stepBars: 4 });
  assert.equal(existsSync(resolveProjectPath('data/trades/paper-state.json')), false);
});

test('labels synthetic data and does not invent strategy P&L', async () => {
  const result = await runWalkForward(candles.slice(0, 16), {
    warmupBars: 4,
    evalBars: 4,
    stepBars: 4,
  });
  assert.equal(result.synthetic, true);
  assert.equal(result.parameterFitting, false);
  assert.ok(result.windows.every((w) => w.strategyRealizedPnl === null || w.status !== 'ok'));
  assert.ok(result.note.includes('does not imply'));
});

test('aggregate counts profitable and unprofitable windows without hiding losses', async () => {
  const result = await runWalkForward(candles, {
    warmupBars: 5,
    evalBars: 10,
    stepBars: 10,
    initialCapital: 1000,
  });
  const sum = result.profitableWindows + result.unprofitableWindows;
  assert.ok(sum <= result.windowsSucceeded);
  assert.ok(result.bestWindow);
  assert.ok(result.worstWindow);
  assert.ok(result.worstWindow.delta <= result.bestWindow.delta);
});
