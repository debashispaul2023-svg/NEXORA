import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi } from '../src/market-data/indicators.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { MarketDataError } from '../src/errors.mjs';

test('SMA warm-up and deterministic values', () => {
  const series = generateSyntheticSeries({ count: 10, startPrice: 100 });
  const period = 3;
  const result = sma(series, period);

  assert.equal(result.length, 10);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.ok(typeof result[2] === 'number');

  // Manual check of first SMA
  const expected = (series[0].close + series[1].close + series[2].close) / 3;
  assert.ok(Math.abs(result[2] - expected) < 1e-9);
});

test('SMA rejects invalid period', () => {
  const series = generateSyntheticSeries({ count: 5 });
  assert.throws(() => sma(series, 0), MarketDataError);
  assert.throws(() => sma(series, -1), MarketDataError);
});

test('EMA produces values only after warm-up', () => {
  const series = generateSyntheticSeries({ count: 8, startPrice: 50 });
  const result = ema(series, 3);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.ok(typeof result[2] === 'number');
  assert.ok(typeof result[7] === 'number');
});

test('RSI warm-up and range', () => {
  const series = generateSyntheticSeries({ count: 20 });
  const result = rsi(series, 14);
  assert.equal(result[13], null); // needs 15 candles (period+1)
  assert.ok(typeof result[14] === 'number');
  for (const v of result) {
    if (v !== null) {
      assert.ok(v >= 0 && v <= 100);
    }
  }
});

test('indicators do not use future data (temporal leakage check)', () => {
  const full = generateSyntheticSeries({ count: 12, startPrice: 100 });
  const truncated = full.slice(0, 8);

  const smaFull = sma(full, 3);
  const smaTrunc = sma(truncated, 3);

  // Values up to the truncated length must match exactly
  for (let i = 0; i < truncated.length; i++) {
    if (smaTrunc[i] === null) {
      assert.equal(smaFull[i], null);
    } else {
      assert.ok(Math.abs(smaFull[i] - smaTrunc[i]) < 1e-9);
    }
  }
});

test('indicators reject empty or malformed series', () => {
  assert.throws(() => sma([], 2), MarketDataError);
  assert.throws(() => ema([{ timestamp: 1, open: 1, high: 1, low: 1, close: NaN, volume: 1 }], 1), MarketDataError);
});
