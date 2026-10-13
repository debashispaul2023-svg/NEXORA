/**
 * Strategy signal interface and evaluation record.
 *
 * A strategy evaluates a validated candle series at a specific timestamp
 * and returns a signal. It never places orders or mutates accounting.
 *
 * Signal values: 'BUY' | 'SELL' | 'HOLD'
 * HOLD and insufficient history produce no order intent.
 *
 * Signals are not predictions of future profit. They are rule outputs only.
 */

export const SIGNAL_TYPES = Object.freeze(['BUY', 'SELL', 'HOLD']);

/**
 * @typedef {object} StrategySignal
 * @property {string} strategyId
 * @property {string} strategyVersion
 * @property {number} timestamp - evaluation candle timestamp (UTC ms)
 * @property {'BUY'|'SELL'|'HOLD'} signal
 * @property {string} reason
 * @property {object} indicators - relevant indicator values at evaluation index
 * @property {boolean} actionable - true only for BUY/SELL with sufficient data
 */

/**
 * Build a minimal evaluation record (separate from outcome).
 * Does not claim success based on subsequent price movement.
 */
export function makeEvaluationRecord({
  strategyId,
  strategyVersion,
  timestamp,
  signal,
  reason,
  indicators = {},
  candleTimestamp,
  orderId = null,
  riskDecision = null,
  executionOutcome = null,
}) {
  return {
    strategyId,
    strategyVersion,
    timestamp,
    signal,
    reason,
    indicators,
    candleTimestamp: candleTimestamp ?? timestamp,
    orderId,
    riskDecision,
    executionOutcome,
    recordedAt: new Date().toISOString(),
  };
}
