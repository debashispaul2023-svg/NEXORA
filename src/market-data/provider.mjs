import { MarketDataError } from '../errors.mjs';
import { validateCandleSeries } from './candle.mjs';
import { buildDatasetReport } from './dataset.mjs';
import { readMarketCache, writeMarketCache, isCacheFresh, DEFAULT_FRESHNESS_MS } from './cache.mjs';
import { AlphaVantageProvider } from './providers/alpha-vantage.mjs';

/**
 * Provider interface contract:
 * fetchDaily({ symbol, apiKey, fetchImpl }) -> { candles, provenance }
 *
 * Synthetic remains the default research source. Network providers are opt-in.
 */

export function createProvider(name) {
  const id = String(name || 'synthetic').toLowerCase();
  if (id === 'synthetic') return null;
  if (id === 'alphavantage' || id === 'alpha-vantage') {
    return new AlphaVantageProvider();
  }
  throw new MarketDataError(`Unknown market-data provider: ${name}`);
}

/**
 * Retrieve validated daily candles from a provider, using cache when fresh.
 * @param {object} opts
 */
export async function fetchValidatedDaily(opts = {}) {
  const providerName = String(opts.provider || '').toLowerCase();
  const symbol = String(opts.symbol || '').trim().toUpperCase();
  if (!symbol) throw new MarketDataError('symbol is required');
  if (!providerName || providerName === 'synthetic') {
    throw new MarketDataError('fetchValidatedDaily requires an explicit non-synthetic provider');
  }

  const freshnessMs = Number.isFinite(opts.freshnessMs) ? opts.freshnessMs : DEFAULT_FRESHNESS_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cached = opts.useCache === false ? null : readMarketCache(providerName, symbol);

  if (cached && isCacheFresh(cached, freshnessMs, nowMs)) {
    const series = validateCandleSeries(cached.candles);
    return {
      candles: series,
      datasetReport: buildDatasetReport(series, { expectedIntervalMs: opts.expectedIntervalMs }),
      cacheStatus: 'fresh',
      provenance: cached.provenance || { provider: providerName, symbol },
    };
  }

  const provider = createProvider(providerName);
  const apiKey = opts.apiKey || process.env.FABINVESTS_ALPHAVANTAGE_KEY || '';
  if (!apiKey) {
    throw new MarketDataError('Missing API key. Set FABINVESTS_ALPHAVANTAGE_KEY. No network call was made.');
  }

  let retrieved;
  try {
    retrieved = await provider.fetchDaily({
      symbol,
      apiKey,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (cached && Array.isArray(cached.candles) && cached.candles.length > 0) {
      const series = validateCandleSeries(cached.candles);
      return {
        candles: series,
        datasetReport: buildDatasetReport(series, { expectedIntervalMs: opts.expectedIntervalMs }),
        cacheStatus: 'stale_fallback',
        provenance: cached.provenance || { provider: providerName, symbol },
        warning: err.message,
      };
    }
    throw err;
  }

  const series = validateCandleSeries(retrieved.candles);
  if (series.length === 0) {
    throw new MarketDataError('Provider returned no usable candles', { symbol, provider: providerName });
  }

  const provenance = {
    provider: providerName,
    symbol,
    interval: '1d',
    realtime: false,
    retrievedAt: nowMs,
    note: 'Daily delayed/historical data. Not real-time.',
    ...retrieved.provenance,
  };

  if (opts.useCache !== false) {
    writeMarketCache({
      provider: providerName,
      symbol,
      retrievedAt: nowMs,
      candles: series,
      provenance,
    });
  }

  return {
    candles: series,
    datasetReport: buildDatasetReport(series, { expectedIntervalMs: opts.expectedIntervalMs }),
    cacheStatus: cached ? 'refreshed' : 'miss',
    provenance,
  };
}
