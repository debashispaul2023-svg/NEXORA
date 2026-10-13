/**
 * Synthetic fixture generation for deterministic tests.
 * All fixtures are explicitly labeled source: 'synthetic'.
 * Never represents live or real market data.
 */

/**
 * Generate a deterministic synthetic OHLCV series.
 * @param {object} opts
 * @param {number} opts.count - number of candles
 * @param {number} [opts.startTs=1700000000000] - UTC ms start
 * @param {number} [opts.intervalMs=60000] - candle interval
 * @param {number} [opts.startPrice=100] - starting close
 * @returns {object[]} candles with source: 'synthetic'
 */
export function generateSyntheticSeries({
  count = 20,
  startTs = 1700000000000,
  intervalMs = 60000,
  startPrice = 100,
} = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('count must be a positive integer');
  }

  const series = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random walk using simple sine + linear
    const delta = Math.sin(i * 0.5) * 2 + (i % 3 === 0 ? 0.5 : -0.3);
    const open = price;
    const close = Math.round((price + delta) * 100) / 100;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.4;
    const volume = 1000 + (i * 10);

    series.push({
      timestamp: startTs + i * intervalMs,
      open,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close,
      volume,
      source: 'synthetic',
      quality: 'synthetic',
    });

    price = close;
  }

  return series;
}

/**
 * Load a small in-memory synthetic fixture (no filesystem required for tests).
 * @returns {object[]}
 */
export function loadSyntheticFixture() {
  return generateSyntheticSeries({ count: 15, startPrice: 50 });
}
