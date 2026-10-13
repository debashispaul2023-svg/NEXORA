/**
 * Prediction evaluation (directional accuracy only).
 *
 * Horizon: fixed number of candles forward (default 1).
 * Target: direction of close[t+horizon] relative to close[t].
 * Score: BUY is correct if future close > entry close; SELL if future close < entry close.
 * HOLD is not scored as a directional prediction.
 *
 * Safeguards:
 * - Prediction is generated only from data at or before t.
 * - Scoring uses future data only after it is available in the supplied series.
 * - Unresolved predictions (not enough future candles) are counted separately.
 * - This is NOT a probability forecast and does not measure trade profitability.
 * - Small synthetic samples must not be treated as statistically reliable.
 */

/**
 * Score directional predictions against a candle series.
 * @param {object[]} records - evaluation records with signal and candleTimestamp
 * @param {object[]} candles - ordered candle series (must include future relative to predictions)
 * @param {number} [horizon=1] - number of candles ahead
 * @returns {object}
 */
export function scoreDirectionalPredictions(records, candles, horizon = 1) {
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new Error('horizon must be a positive integer');
  }
  const series = Array.isArray(candles) ? candles : [];
  const byTs = new Map(series.map((c, i) => [c.timestamp, { candle: c, index: i }]));

  let scored = 0;
  let correct = 0;
  let incorrect = 0;
  let unresolved = 0;
  let skippedHold = 0;
  const details = [];

  for (const r of records || []) {
    if (r.signal === 'HOLD') {
      skippedHold += 1;
      continue;
    }
    if (r.signal !== 'BUY' && r.signal !== 'SELL') continue;

    const entry = byTs.get(r.candleTimestamp);
    if (!entry) {
      unresolved += 1;
      details.push({ id: r.id, status: 'unresolved', reason: 'entry_candle_missing' });
      continue;
    }
    const targetIdx = entry.index + horizon;
    if (targetIdx >= series.length) {
      unresolved += 1;
      details.push({
        id: r.id,
        status: 'unresolved',
        reason: 'horizon_not_reached',
        predictionTimestamp: r.candleTimestamp,
        targetIndex: targetIdx,
      });
      continue;
    }

    const entryClose = entry.candle.close;
    const targetClose = series[targetIdx].close;
    const up = targetClose > entryClose;
    const down = targetClose < entryClose;
    let isCorrect = false;
    if (r.signal === 'BUY' && up) isCorrect = true;
    if (r.signal === 'SELL' && down) isCorrect = true;
    // flat move: neither correct nor incorrect for directional score
    if (targetClose === entryClose) {
      scored += 1;
      details.push({
        id: r.id,
        status: 'flat',
        signal: r.signal,
        entryClose,
        targetClose,
        targetTimestamp: series[targetIdx].timestamp,
      });
      continue;
    }

    scored += 1;
    if (isCorrect) correct += 1;
    else incorrect += 1;
    details.push({
      id: r.id,
      status: isCorrect ? 'correct' : 'incorrect',
      signal: r.signal,
      entryClose,
      targetClose,
      targetTimestamp: series[targetIdx].timestamp,
    });
  }

  return {
    horizon,
    scored,
    correct,
    incorrect,
    unresolved,
    skippedHold,
    directionalAccuracy: scored === 0 ? null : correct / scored,
    note: 'Directional accuracy is not trade profitability and is not a calibrated probability.',
    details,
  };
}
