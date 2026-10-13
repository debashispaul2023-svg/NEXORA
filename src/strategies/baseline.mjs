import { sma, ema, rsi } from '../market-data/indicators.mjs';
import { validateCandleSeries } from '../market-data/candle.mjs';
import { MarketDataError } from '../errors.mjs';

/**
 * Baseline SMA/EMA/RSI strategy.
 *
 * ID: baseline-sma-ema-rsi
 * Version: 1.0.0
 *
 * Rules (evaluated only at the last candle of the supplied series):
 * - If any required indicator is null (insufficient history) → HOLD, not actionable.
 * - BUY  if close > SMA(fast) AND close > EMA(fast) AND RSI < rsiBuyMax
 * - SELL if close < SMA(fast) AND RSI > rsiSellMin
 * - Otherwise HOLD
 *
 * These rules do not predict future prices and do not guarantee profit.
 * SELL may be rejected later by risk if no long position exists.
 *
 * Causality: indicators are computed on the full supplied series; the signal
 * uses only the value at the final index, which itself uses only candles
 * up to that index.
 */

export const STRATEGY_ID = 'baseline-sma-ema-rsi';
export const STRATEGY_VERSION = '1.0.0';

export const DEFAULT_PARAMS = Object.freeze({
  smaPeriod: 5,
  emaPeriod: 5,
  rsiPeriod: 14,
  rsiBuyMax: 70,
  rsiSellMin: 30,
  quantity: 1,
});

/**
 * Evaluate the baseline strategy on a candle series.
 * @param {object[]} candles - ordered ascending; signal is for the last candle
 * @param {object} [params]
 * @returns {import('./interface.mjs').StrategySignal}
 */
export function evaluateBaseline(candles, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const series = validateCandleSeries(candles);
  if (series.length === 0) {
    throw new MarketDataError('Strategy requires a non-empty candle series');
  }

  const idx = series.length - 1;
  const candle = series[idx];

  const smaVals = sma(series, p.smaPeriod);
  const emaVals = ema(series, p.emaPeriod);
  const rsiVals = rsi(series, p.rsiPeriod);

  const indicators = {
    sma: smaVals[idx],
    ema: emaVals[idx],
    rsi: rsiVals[idx],
    close: candle.close,
  };

  const base = {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    timestamp: candle.timestamp,
    indicators,
  };

  if (indicators.sma === null || indicators.ema === null || indicators.rsi === null) {
    return {
      ...base,
      signal: 'HOLD',
      reason: 'insufficient_history',
      actionable: false,
    };
  }

  if (candle.close > indicators.sma && candle.close > indicators.ema && indicators.rsi < p.rsiBuyMax) {
    return {
      ...base,
      signal: 'BUY',
      reason: 'close_above_sma_ema_and_rsi_not_overbought',
      actionable: true,
      quantity: p.quantity,
    };
  }

  if (candle.close < indicators.sma && indicators.rsi > p.rsiSellMin) {
    return {
      ...base,
      signal: 'SELL',
      reason: 'close_below_sma_and_rsi_not_oversold',
      actionable: true,
      quantity: p.quantity,
    };
  }

  return {
    ...base,
    signal: 'HOLD',
    reason: 'no_rule_matched',
    actionable: false,
  };
}
