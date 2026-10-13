import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCandle, validateCandleSeries, normalizeTimestamp } from '../src/market-data/candle.mjs';
import { generateSyntheticSeries, loadSyntheticFixture } from '../src/market-data/fixtures.mjs';
import { MarketDataError } from '../src/errors.mjs';

test('normalizeTimestamp accepts number and ISO string', () => {
  assert.equal(normalizeTimestamp(1700000000000), 1700000000000);
  assert.equal(normalizeTimestamp('2023-11-14T22:13:20.000Z'), Date.parse('2023-11-14T22:13:20.000Z'));
});

test('normalizeTimestamp rejects invalid', () => {
  assert.throws(() => normalizeTimestamp('not-a-date'), MarketDataError);
  assert.throws(() => normalizeTimestamp(NaN), MarketDataError);
});

test('validateCandle accepts valid OHLC', () => {
  const c = validateCandle({
    timestamp: 1700000000000,
    open: 100,
    high: 105,
    low: 98,
    close: 102,
    volume: 500,
    source: 'synthetic',
  });
  assert.equal(c.close, 102);
  assert.equal(c.source, 'synthetic');
});

test('validateCandle rejects negative volume', () => {
  assert.throws(() => validateCandle({
    timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: -1,
  }), /non-negative/);
});

test('validateCandle rejects OHLC inconsistency', () => {
  assert.throws(() => validateCandle({
    timestamp: 1, open: 10, high: 9, low: 8, close: 9.5, volume: 1,
  }), MarketDataError);
});

test('validateCandleSeries rejects duplicates and out-of-order', () => {
  const good = generateSyntheticSeries({ count: 5 });
  const normalized = validateCandleSeries(good);
  assert.equal(normalized.length, 5);

  const dup = [...good];
  dup[2] = { ...dup[2], timestamp: dup[1].timestamp };
  assert.throws(() => validateCandleSeries(dup), /Duplicate/);

  const ooo = [...good];
  ooo[3] = { ...ooo[3], timestamp: ooo[0].timestamp - 1000 };
  assert.throws(() => validateCandleSeries(ooo), /Out-of-order/);
});

test('synthetic fixtures are labeled and deterministic', () => {
  const a = generateSyntheticSeries({ count: 10 });
  const b = generateSyntheticSeries({ count: 10 });
  assert.deepEqual(a, b);
  assert.equal(a[0].source, 'synthetic');
  assert.equal(a[0].quality, 'synthetic');

  const loaded = loadSyntheticFixture();
  assert.ok(loaded.length > 0);
  assert.equal(loaded[0].source, 'synthetic');
});

test('validateCandleSeries rejects non-array', () => {
  assert.throws(() => validateCandleSeries(null), MarketDataError);
});
