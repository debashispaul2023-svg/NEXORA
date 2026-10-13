import { MarketDataError } from '../errors.mjs';
import { validateCandleSeries } from './candle.mjs';

/**
 * Basic technical indicators.
 * All calculations are strictly causal: value at index i uses only candles[0..i].
 * Insufficient history returns null (explicit warm-up).
 * Invalid inputs throw MarketDataError.
 */

function requireSeries(candles) {
  const series = validateCandleSeries(candles);
  if (series.length === 0) {
    throw new MarketDataError('Indicator requires a non-empty candle series');
  }
  return series;
}

/**
 * Simple Moving Average of close prices.
 * @param {object[]} candles
 * @param {number} period
 * @returns {(number|null)[]} length === candles.length; null during warm-up
 */
export function sma(candles, period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new MarketDataError('SMA period must be a positive integer', { period });
  }
  const series = requireSeries(candles);
  const result = new Array(series.length).fill(null);

  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i].close;
    if (i >= period) {
      sum -= series[i - period].close;
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }
  return result;
}

/**
 * Exponential Moving Average of close prices.
 * Seeded with SMA of the first `period` closes.
 * @param {object[]} candles
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function ema(candles, period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new MarketDataError('EMA period must be a positive integer', { period });
  }
  const series = requireSeries(candles);
  const result = new Array(series.length).fill(null);
  if (series.length < period) return result;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += series[i].close;
  let prev = sum / period;
  result[period - 1] = prev;

  for (let i = period; i < series.length; i++) {
    prev = series[i].close * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

/**
 * Relative Strength Index (Wilder).
 * Uses only past closes; null until period+1 candles available.
 * @param {object[]} candles
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function rsi(candles, period = 14) {
  if (!Number.isInteger(period) || period < 1) {
    throw new MarketDataError('RSI period must be a positive integer', { period });
  }
  const series = requireSeries(candles);
  const result = new Array(series.length).fill(null);
  if (series.length < period + 1) return result;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = series[i].close - series[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const firstIdx = period;
  if (avgLoss === 0) {
    result[firstIdx] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[firstIdx] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < series.length; i++) {
    const change = series[i].close - series[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }
  return result;
}
