import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPaperSession } from '../src/paper/session.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import { MarketDataError } from '../src/errors.mjs';

const good = generateSyntheticSeries({ count: 12, startTs: Date.UTC(2024, 0, 2) });

test('valid synthetic series reaches paper workflow without network', async () => {
  const result = await runPaperSession({
    candles: good,
    provenance: { provider: 'synthetic', symbol: 'SYNTH', realtime: false },
  });
  assert.equal(result.mode, 'paper');
  assert.equal(result.synthetic, true);
  assert.equal(result.seriesCount, 12);
  assert.equal(result.datasetReport.ok, true);
  assert.equal(result.outcomes.length, 12);
  assert.equal(result.provenance.realtime, false);
});

test('invalid candles are rejected before state mutation', async () => {
  await assert.rejects(
    () => runPaperSession({
      candles: [{ timestamp: 1, open: 10, high: 9, low: 8, close: 9, volume: 1 }],
      provenance: { provider: 'synthetic' },
    }),
    MarketDataError,
  );
});

test('empty series is rejected', async () => {
  await assert.rejects(
    () => runPaperSession({ candles: [], provenance: { provider: 'synthetic' } }),
    /Empty series/,
  );
});

test('duplicate candle identity is not reprocessed', async () => {
  const series = generateSyntheticSeries({ count: 6, startTs: Date.UTC(2024, 0, 2) });
  const first = await runPaperSession({
    candles: series,
    provenance: { provider: 'alphavantage', symbol: 'IBM' },
    cacheStatus: 'fresh',
  });
  const second = await runPaperSession({
    candles: series,
    provenance: { provider: 'alphavantage', symbol: 'IBM' },
    cacheStatus: 'fresh',
    processed: first.processed,
  });
  assert.equal(second.outcomes.every((o) => o.skipped), true);
  assert.equal(second.mutated, false);
});

test('stale fallback blocks provider-backed execution', async () => {
  await assert.rejects(
    () => runPaperSession({
      candles: good,
      provenance: { provider: 'alphavantage', symbol: 'IBM' },
      cacheStatus: 'stale_fallback',
    }),
    /Stale cached data/,
  );
});

test('synthetic mode is independent of provider cache status', async () => {
  const result = await runPaperSession({
    candles: good,
    provenance: { provider: 'synthetic' },
    cacheStatus: 'stale_fallback',
  });
  assert.equal(result.synthetic, true);
  assert.equal(result.seriesCount, 12);
});

test('risk rejection does not mutate ledger', async () => {
  const series = generateSyntheticSeries({ count: 8, startTs: Date.UTC(2024, 0, 2) });
  const result = await runPaperSession({
    candles: series,
    provenance: { provider: 'synthetic' },
    riskLimits: { maxPositionNotional: 0 },
    initialCapital: 1000,
  });
  assert.equal(result.snapshot.cash, 1000);
  assert.equal(result.snapshot.positionQty, 0);
});
