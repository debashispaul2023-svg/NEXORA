import { MarketDataError } from '../../errors.mjs';

/**
 * Alpha Vantage daily equity adapter (read-only).
 * Uses TIME_SERIES_DAILY. Free tier returns compact history (latest ~100 points).
 * Full history is premium and is not requested here.
 * Data is historical/delayed. Never described as real-time.
 */

const ENDPOINT = 'https://www.alphavantage.co/query';

export class AlphaVantageProvider {
  async fetchDaily({ symbol, apiKey, fetchImpl = fetch } = {}) {
    if (!symbol) throw new MarketDataError('symbol is required');
    if (!apiKey) throw new MarketDataError('Alpha Vantage API key is required');

    const url = new URL(ENDPOINT);
    url.searchParams.set('function', 'TIME_SERIES_DAILY');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('outputsize', 'compact');
    url.searchParams.set('datatype', 'json');
    url.searchParams.set('apikey', apiKey);

    let response;
    try {
      response = await fetchImpl(url.toString());
    } catch (err) {
      throw new MarketDataError('Alpha Vantage network failure', { cause: err.message });
    }

    if (!response || !response.ok) {
      throw new MarketDataError('Alpha Vantage HTTP failure', {
        status: response?.status ?? null,
      });
    }

    let body;
    try {
      body = await response.json();
    } catch (err) {
      throw new MarketDataError('Alpha Vantage response was not JSON', { cause: err.message });
    }

    if (body['Error Message']) {
      throw new MarketDataError('Alpha Vantage rejected the request', {
        error: body['Error Message'],
      });
    }
    if (body.Note || body.Information) {
      throw new MarketDataError('Alpha Vantage rate limit or notice', {
        note: body.Note || body.Information,
      });
    }

    const series = body['Time Series (Daily)'];
    if (!series || typeof series !== 'object') {
      throw new MarketDataError('Alpha Vantage response missing Time Series (Daily)');
    }

    const candles = Object.entries(series).map(([date, bar]) => ({
      timestamp: Date.parse(`${date}T00:00:00.000Z`),
      open: Number(bar['1. open']),
      high: Number(bar['2. high']),
      low: Number(bar['3. low']),
      close: Number(bar['4. close']),
      volume: Number(bar['5. volume']),
      source: 'alphavantage',
      quality: 'delayed_daily',
    }));

    candles.sort((a, b) => a.timestamp - b.timestamp);

    return {
      candles,
      provenance: {
        provider: 'alphavantage',
        symbol,
        endpoint: 'TIME_SERIES_DAILY',
        outputsize: 'compact',
        realtime: false,
        note: 'Free compact daily history. Not real-time. Full history requires a premium key.',
      },
    };
  }
}
