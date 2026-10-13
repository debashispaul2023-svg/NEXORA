import { MarketDataError } from '../errors.mjs';

/**
 * OHLCV candle representation and validation.
 * All timestamps are normalized to UTC milliseconds.
 * Synthetic vs live distinction is explicit; this module never fabricates live data.
 */

/**
 * Normalize a timestamp to UTC milliseconds.
 * Accepts number (ms) or ISO string.
 * @param {number|string} ts
 * @returns {number}
 */
export function normalizeTimestamp(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return Math.floor(ts);
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new MarketDataError('Invalid timestamp', { value: ts });
}

/**
 * Validate a single candle object.
 * Expected shape: { timestamp, open, high, low, close, volume, source? }
 * @param {object} candle
 * @returns {object} Normalized candle
 */
export function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') {
    throw new MarketDataError('Candle must be an object');
  }

  const timestamp = normalizeTimestamp(candle.timestamp);
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const volume = Number(candle.volume);

  const numbers = { open, high, low, close, volume };
  for (const [k, v] of Object.entries(numbers)) {
    if (!Number.isFinite(v)) {
      throw new MarketDataError(`Candle field ${k} must be a finite number`, { field: k, value: candle[k] });
    }
  }

  if (volume < 0) {
    throw new MarketDataError('Volume must be non-negative', { volume });
  }

  if (high < low) {
    throw new MarketDataError('high must be >= low', { high, low });
  }
  if (high < Math.max(open, close) || low > Math.min(open, close)) {
    throw new MarketDataError('OHLC consistency violated (high/low must bound open/close)', {
      open, high, low, close,
    });
  }

  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    source: candle.source === 'synthetic' ? 'synthetic' : (candle.source || 'unknown'),
    quality: candle.quality || 'unknown',
  };
}

/**
 * Validate an ordered series of candles.
 * Rejects duplicates, out-of-order timestamps, and malformed candles.
 * @param {object[]} candles
 * @returns {object[]} Normalized series
 */
export function validateCandleSeries(candles) {
  if (!Array.isArray(candles)) {
    throw new MarketDataError('Candle series must be an array');
  }
  if (candles.length === 0) {
    return [];
  }

  const normalized = candles.map((c, i) => {
    try {
      return validateCandle(c);
    } catch (err) {
      throw new MarketDataError(`Invalid candle at index ${i}: ${err.message}`, { index: i, cause: err.message });
    }
  });

  for (let i = 1; i < normalized.length; i++) {
    const prev = normalized[i - 1].timestamp;
    const curr = normalized[i].timestamp;
    if (curr === prev) {
      throw new MarketDataError('Duplicate timestamp in series', { index: i, timestamp: curr });
    }
    if (curr < prev) {
      throw new MarketDataError('Out-of-order timestamps', { index: i, prev, curr });
    }
  }

  return normalized;
}
