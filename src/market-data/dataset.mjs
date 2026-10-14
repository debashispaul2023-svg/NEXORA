import { validateCandle, validateCandleSeries } from './candle.mjs';
import { MarketDataError } from '../errors.mjs';

/**
 * Deterministic dataset validation report.
 *
 * Does not replace validateCandle, validateCandleSeries, or
 * validateHistoricalSeries. Those functions still throw on invalid input
 * and remain the backtest gate. This builder only reports.
 *
 * Does not repair data, fabricate candles, or infer sessions or holidays.
 *
 * Issue codes:
 * - INVALID_TIMESTAMP, NON_FINITE_FIELD, NEGATIVE_VOLUME,
 *   OHLC_HIGH_LOW, OHLC_BOUNDS, DUPLICATE_TIMESTAMP, OUT_OF_ORDER,
 *   EMPTY_SERIES — severity error
 * - TIME_GAP — severity warning, only when expectedIntervalMs is supplied
 * - ZERO_VOLUME, FLAT_OHLC, LARGE_RANGE — severity info
 *
 * index is the 0-based input index of the candle, or null for series-level issues.
 * ok is false when any error exists, true otherwise. Warnings and info do not fail ok.
 */

const LARGE_RANGE_RATIO = 0.5;

function classifyCandleError(message) {
  if (/timestamp/i.test(message)) return 'INVALID_TIMESTAMP';
  if (/Volume must be non-negative/i.test(message)) return 'NEGATIVE_VOLUME';
  if (/high must be >= low/i.test(message)) return 'OHLC_HIGH_LOW';
  if (/OHLC consistency/i.test(message)) return 'OHLC_BOUNDS';
  if (/finite number/i.test(message)) return 'NON_FINITE_FIELD';
  return 'INVALID_CANDLE';
}

function pushIssue(issues, severity, code, index, message) {
  issues.push({ severity, code, index, message });
}

/**
 * Build a validation report for a candle dataset.
 * @param {object[]} candles
 * @param {object} [opts]
 * @param {number} [opts.expectedIntervalMs] - if set, gaps larger than this are warnings
 * @returns {{ ok: boolean, errorCount: number, warningCount: number, infoCount: number, issues: object[] }}
 */
export function buildDatasetReport(candles, opts = {}) {
  const issues = [];

  if (!Array.isArray(candles)) {
    pushIssue(issues, 'error', 'INVALID_CANDLE', null, 'Dataset must be an array');
    return summarize(issues);
  }
  if (candles.length === 0) {
    pushIssue(issues, 'error', 'EMPTY_SERIES', null, 'Dataset is empty');
    return summarize(issues);
  }

  const normalized = [];
  let candleErrors = 0;
  for (let i = 0; i < candles.length; i++) {
    try {
      const c = validateCandle(candles[i]);
      normalized.push(c);
      if (c.volume === 0) {
        pushIssue(issues, 'info', 'ZERO_VOLUME', i, 'Volume is zero');
      }
      if (c.open === c.high && c.high === c.low && c.low === c.close) {
        pushIssue(issues, 'info', 'FLAT_OHLC', i, 'Open, high, low, and close are equal');
      }
      if (c.open !== 0 && (c.high - c.low) > Math.abs(c.open) * LARGE_RANGE_RATIO) {
        pushIssue(issues, 'info', 'LARGE_RANGE', i, 'Bar range exceeds 50% of open');
      }
    } catch (err) {
      candleErrors += 1;
      const message = err instanceof MarketDataError ? err.message : String(err.message || err);
      pushIssue(issues, 'error', classifyCandleError(message), i, message);
      normalized.push(null);
    }
  }

  if (candleErrors === 0) {
    try {
      validateCandleSeries(candles);
    } catch (err) {
      const message = err.message || String(err);
      const index = err.details?.index ?? null;
      const code = /Duplicate/i.test(message) ? 'DUPLICATE_TIMESTAMP'
        : /Out-of-order/i.test(message) ? 'OUT_OF_ORDER'
          : 'INVALID_CANDLE';
      pushIssue(issues, 'error', code, index, message);
    }

    const expected = opts.expectedIntervalMs;
    if (Number.isFinite(expected) && expected > 0) {
      for (let i = 1; i < normalized.length; i++) {
        const prev = normalized[i - 1];
        const curr = normalized[i];
        if (!prev || !curr) continue;
        const gap = curr.timestamp - prev.timestamp;
        if (gap > expected) {
          pushIssue(
            issues,
            'warning',
            'TIME_GAP',
            i,
            `Gap of ${gap} ms exceeds expectedIntervalMs ${expected}`,
          );
        }
      }
    }
  }

  return summarize(issues);
}

function summarize(issues) {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    issues,
  };
}
