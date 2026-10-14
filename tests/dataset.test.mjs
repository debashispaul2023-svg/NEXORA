import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatasetReport } from '../src/market-data/dataset.mjs';
import { validateHistoricalSeries } from '../src/backtest/input.mjs';
import { MarketDataError } from '../src/errors.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';

const valid = generateSyntheticSeries({ count: 5, startPrice: 100, startTs: 1_700_000_000_000, intervalMs: 60_000 });

test('valid synthetic series is ok with no errors', () => {
  const report = buildDatasetReport(valid);
  assert.equal(report.ok, true);
  assert.equal(report.errorCount, 0);
  assert.equal(report.warningCount, 0);
});

test('malformed timestamp is an error', () => {
  const bad = [{ ...valid[0], timestamp: 'not-a-date' }];
  const report = buildDatasetReport(bad);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'INVALID_TIMESTAMP' && i.index === 0));
});

test('duplicate timestamps are an error', () => {
  const dup = [valid[0], { ...valid[1], timestamp: valid[0].timestamp }];
  const report = buildDatasetReport(dup);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'DUPLICATE_TIMESTAMP'));
});

test('out-of-order timestamps are an error', () => {
  const ooo = [valid[1], valid[0]];
  const report = buildDatasetReport(ooo);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'OUT_OF_ORDER'));
});

test('OHLC violations are errors', () => {
  const badHighLow = [{ ...valid[0], high: 1, low: 5 }];
  const highLow = buildDatasetReport(badHighLow);
  assert.equal(highLow.ok, false);
  assert.ok(highLow.issues.some((i) => i.code === 'OHLC_HIGH_LOW'));

  const badBounds = [{ ...valid[0], open: 100, high: 101, low: 99, close: 102 }];
  const bounds = buildDatasetReport(badBounds);
  assert.equal(bounds.ok, false);
  assert.ok(bounds.issues.some((i) => i.code === 'OHLC_BOUNDS'));
});

test('gap is a warning only when expectedIntervalMs is supplied', () => {
  const gapped = [
    valid[0],
    { ...valid[1], timestamp: valid[0].timestamp + 180_000 },
  ];
  const withInterval = buildDatasetReport(gapped, { expectedIntervalMs: 60_000 });
  assert.equal(withInterval.ok, true);
  assert.equal(withInterval.errorCount, 0);
  assert.ok(withInterval.issues.some((i) => i.severity === 'warning' && i.code === 'TIME_GAP'));

  const without = buildDatasetReport(gapped);
  assert.equal(without.ok, true);
  assert.equal(without.issues.filter((i) => i.code === 'TIME_GAP').length, 0);
});

test('zero volume and flat OHLC are informational', () => {
  const unusual = [{
    timestamp: 1_000,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 0,
  }];
  const report = buildDatasetReport(unusual);
  assert.equal(report.ok, true);
  assert.ok(report.issues.some((i) => i.code === 'ZERO_VOLUME' && i.severity === 'info'));
  assert.ok(report.issues.some((i) => i.code === 'FLAT_OHLC' && i.severity === 'info'));
});

test('existing historical validation still rejects invalid data', () => {
  assert.throws(() => validateHistoricalSeries([]), MarketDataError);
  assert.throws(
    () => validateHistoricalSeries([valid[0], { ...valid[1], timestamp: valid[0].timestamp }]),
    MarketDataError,
  );
});

function assertCounts(report) {
  assert.equal(report.ok, report.errorCount === 0);
  assert.equal(report.errorCount, report.issues.filter((i) => i.severity === 'error').length);
  assert.equal(report.warningCount, report.issues.filter((i) => i.severity === 'warning').length);
  assert.equal(report.infoCount, report.issues.filter((i) => i.severity === 'info').length);
}

test('empty dataset and non-array input are series-level errors', () => {
  const empty = buildDatasetReport([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.issues[0].code, 'EMPTY_SERIES');
  assert.equal(empty.issues[0].index, null);
  assertCounts(empty);

  const notArray = buildDatasetReport(null);
  assert.equal(notArray.ok, false);
  assert.equal(notArray.issues[0].code, 'INVALID_CANDLE');
  assert.equal(notArray.issues[0].index, null);
  assertCounts(notArray);
});

test('negative volume and non-finite OHLC are errors', () => {
  const neg = buildDatasetReport([{ ...valid[0], volume: -1 }]);
  assert.equal(neg.ok, false);
  assert.ok(neg.issues.some((i) => i.code === 'NEGATIVE_VOLUME' && i.index === 0));
  assertCounts(neg);

  const nan = buildDatasetReport([{ ...valid[0], close: Number.NaN }]);
  assert.equal(nan.ok, false);
  assert.ok(nan.issues.some((i) => i.code === 'NON_FINITE_FIELD' && i.index === 0));
  assertCounts(nan);
});

test('invalid expectedIntervalMs values do not create TIME_GAP warnings', () => {
  const gapped = [
    valid[0],
    { ...valid[1], timestamp: valid[0].timestamp + 180_000 },
  ];
  for (const expectedIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000']) {
    const report = buildDatasetReport(gapped, { expectedIntervalMs });
    assert.equal(report.ok, true);
    assert.equal(report.issues.filter((i) => i.code === 'TIME_GAP').length, 0);
    assertCounts(report);
  }
});

test('malformed timestamp does not produce duplicate or order findings', () => {
  const report = buildDatasetReport([
    { ...valid[0], timestamp: 'not-a-date' },
    { ...valid[1], timestamp: valid[0].timestamp },
  ]);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'INVALID_TIMESTAMP'));
  assert.equal(report.issues.filter((i) => i.code === 'DUPLICATE_TIMESTAMP').length, 0);
  assert.equal(report.issues.filter((i) => i.code === 'OUT_OF_ORDER').length, 0);
  assertCounts(report);
});

test('LARGE_RANGE uses absolute open and skips zero open', () => {
  const zeroOpen = buildDatasetReport([{
    timestamp: 1_000,
    open: 0,
    high: 1,
    low: 0,
    close: 0.5,
    volume: 1,
  }]);
  assert.equal(zeroOpen.ok, true);
  assert.equal(zeroOpen.issues.filter((i) => i.code === 'LARGE_RANGE').length, 0);
  assertCounts(zeroOpen);

  const negativeOpen = buildDatasetReport([{
    timestamp: 1_000,
    open: -10,
    high: -4,
    low: -11,
    close: -5,
    volume: 1,
  }]);
  assert.equal(negativeOpen.ok, true);
  assert.ok(negativeOpen.issues.some((i) => i.code === 'LARGE_RANGE' && i.severity === 'info' && i.index === 0));
  assertCounts(negativeOpen);
});
