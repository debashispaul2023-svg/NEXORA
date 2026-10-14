import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlphaVantageProvider } from '../src/market-data/providers/alpha-vantage.mjs';
import { fetchValidatedDaily, createProvider } from '../src/market-data/provider.mjs';
import { isCacheFresh, writeMarketCache, readMarketCache } from '../src/market-data/cache.mjs';
import { MarketDataError } from '../src/errors.mjs';

function mockResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

const sampleSeries = {
  'Time Series (Daily)': {
    '2024-01-03': { '1. open': '101', '2. high': '102', '3. low': '100', '4. close': '101.5', '5. volume': '1000' },
    '2024-01-02': { '1. open': '100', '2. high': '101', '3. low': '99', '4. close': '100.5', '5. volume': '900' },
  },
};

test('createProvider rejects unknown and returns null for synthetic', () => {
  assert.equal(createProvider('synthetic'), null);
  assert.throws(() => createProvider('stooq'), MarketDataError);
});

test('Alpha Vantage adapter normalizes daily bars and sorts chronologically', async () => {
  const provider = new AlphaVantageProvider();
  const result = await provider.fetchDaily({
    symbol: 'IBM',
    apiKey: 'test-key',
    fetchImpl: async () => mockResponse(sampleSeries),
  });
  assert.equal(result.candles.length, 2);
  assert.ok(result.candles[0].timestamp < result.candles[1].timestamp);
  assert.equal(result.candles[0].source, 'alphavantage');
  assert.equal(result.provenance.realtime, false);
  assert.equal(result.candles[0].timestamp, Date.parse('2024-01-02T00:00:00.000Z'));
});

test('Alpha Vantage surfaces error and rate-limit payloads', async () => {
  const provider = new AlphaVantageProvider();
  await assert.rejects(
    () => provider.fetchDaily({
      symbol: 'BAD',
      apiKey: 'k',
      fetchImpl: async () => mockResponse({ 'Error Message': 'Invalid API call' }),
    }),
    /rejected/i,
  );
  await assert.rejects(
    () => provider.fetchDaily({
      symbol: 'IBM',
      apiKey: 'k',
      fetchImpl: async () => mockResponse({ Note: 'rate limit' }),
    }),
    /rate limit/i,
  );
});

test('missing API key fails closed with no network call', async () => {
  const prev = process.env.FABINVESTS_ALPHAVANTAGE_KEY;
  delete process.env.FABINVESTS_ALPHAVANTAGE_KEY;
  let called = false;
  await assert.rejects(
    () => fetchValidatedDaily({
      provider: 'alphavantage',
      symbol: 'IBM',
      useCache: false,
      fetchImpl: async () => { called = true; return mockResponse(sampleSeries); },
      apiKey: '',
    }),
    /Missing API key/,
  );
  assert.equal(called, false);
  if (prev) process.env.FABINVESTS_ALPHAVANTAGE_KEY = prev;
});

test('fetchValidatedDaily validates and reports dataset quality', async () => {
  const result = await fetchValidatedDaily({
    provider: 'alphavantage',
    symbol: 'IBM',
    apiKey: 'test-key',
    useCache: false,
    fetchImpl: async () => mockResponse(sampleSeries),
  });
  assert.equal(result.candles.length, 2);
  assert.equal(result.datasetReport.ok, true);
  assert.equal(result.provenance.realtime, false);
  assert.equal(result.cacheStatus, 'miss');
});

test('fresh cache is used without calling fetch', async () => {
  writeMarketCache({
    provider: 'alphavantage',
    symbol: 'CACHE1',
    retrievedAt: Date.now(),
    candles: [{
      timestamp: Date.parse('2024-01-02T00:00:00.000Z'),
      open: 10, high: 11, low: 9, close: 10.5, volume: 100,
      source: 'alphavantage', quality: 'delayed_daily',
    }],
    provenance: { provider: 'alphavantage', symbol: 'CACHE1', realtime: false },
  });
  let called = false;
  const result = await fetchValidatedDaily({
    provider: 'alphavantage',
    symbol: 'CACHE1',
    apiKey: 'test-key',
    fetchImpl: async () => { called = true; return mockResponse(sampleSeries); },
  });
  assert.equal(called, false);
  assert.equal(result.cacheStatus, 'fresh');
  assert.equal(result.candles.length, 1);
});

test('stale cache is refreshed when fetch succeeds', async () => {
  writeMarketCache({
    provider: 'alphavantage',
    symbol: 'CACHE2',
    retrievedAt: Date.now() - 48 * 60 * 60 * 1000,
    candles: [{
      timestamp: Date.parse('2024-01-02T00:00:00.000Z'),
      open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
      source: 'alphavantage', quality: 'delayed_daily',
    }],
    provenance: { provider: 'alphavantage', symbol: 'CACHE2' },
  });
  const result = await fetchValidatedDaily({
    provider: 'alphavantage',
    symbol: 'CACHE2',
    apiKey: 'test-key',
    freshnessMs: 60_000,
    fetchImpl: async () => mockResponse(sampleSeries),
  });
  assert.equal(result.cacheStatus, 'refreshed');
  assert.equal(result.candles.length, 2);
});

test('isCacheFresh rejects missing and expired records', () => {
  assert.equal(isCacheFresh(null), false);
  assert.equal(isCacheFresh({ retrievedAt: Date.now() - 10_000 }, 1000), false);
  assert.equal(isCacheFresh({ retrievedAt: Date.now() }, 60_000), true);
  assert.equal(readMarketCache('alphavantage', 'does-not-exist'), null);
});
