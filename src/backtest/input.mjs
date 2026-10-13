import { validateCandleSeries } from '../market-data/candle.mjs';
import { MarketDataError } from '../errors.mjs';
import { createHash } from 'node:crypto';

/**
 * Historical OHLCV input for backtesting.
 *
 * Accepts deterministic synthetic fixtures or validated local candle data.
 * Does not fabricate missing candles or prices.
 * Does not connect to live providers.
 */

/**
 * Validate a historical candle series for backtesting.
 * @param {object[]} candles
 * @returns {{ series: object[], identity: string, count: number, startTs: number, endTs: number }}
 */
export function validateHistoricalSeries(candles) {
  const series = validateCandleSeries(candles);
  if (series.length === 0) {
    throw new MarketDataError('Historical series is empty');
  }

  // Additional chronological and duplicate checks (validateCandleSeries already orders)
  for (let i = 1; i < series.length; i++) {
    if (series[i].timestamp <= series[i - 1].timestamp) {
      throw new MarketDataError('Series must be strictly chronological with no duplicate timestamps', {
        index: i,
        timestamp: series[i].timestamp,
      });
    }
  }

  const identity = computeSeriesIdentity(series);
  return {
    series,
    identity,
    count: series.length,
    startTs: series[0].timestamp,
    endTs: series[series.length - 1].timestamp,
  };
}

/**
 * Stable identity for a series (deterministic).
 * @param {object[]} series
 * @returns {string}
 */
export function computeSeriesIdentity(series) {
  const payload = series.map((c) => `${c.timestamp}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}`).join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
