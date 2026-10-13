/**
 * Deterministic performance analytics derived from evaluation records and ledger.
 *
 * Definitions:
 * - totalSignals: count of evaluation records
 * - actionableSignals: records with signal BUY or SELL (actionable intent)
 * - submittedOrders: records with non-null orderId
 * - acceptedOrders: records where executionOutcome.approved === true
 * - rejectedOrders: records with orderId and approved === false (or outcome risk_rejected etc.)
 * - completedTrades: closed round-trips inferred from ledger SELL entries that reduce position
 *   (each SELL that realizes P&L counts as one completed trade unit for that fill)
 * - winningTrades: completed trades with positive realized contribution
 * - losingTrades: completed trades with negative realized contribution
 * - winRate: winningTrades / completedTrades (null if completedTrades === 0)
 * - realizedPnl: from ledger.snapshot().realizedPnl
 * - unrealizedPnl: from markToMarket when markPrice provided; else unavailable
 * - totalFees: sum of feeCents from ledger / 100
 * - equity: from markToMarket when markPrice provided; else cash only
 * - maxDrawdown: peak-to-trough equity decline over equitySeries when provided
 *
 * Open positions are NOT counted as completed wins/losses.
 * Missing data → metric is null / unavailable, never invented.
 *
 * Strategy-level realized P&L is unavailable. Multiple strategies may share
 * one aggregate position. Without a documented allocation model, realized
 * P&L cannot be attributed to an individual strategy. Portfolio-level
 * realizedPnl remains authoritative. strategyRealizedPnl is always null.
 */

/**
 * Summarize evaluation records.
 * @param {object[]} records
 * @returns {object}
 */
export function summarizeSignals(records) {
  const list = Array.isArray(records) ? records : [];
  let actionable = 0;
  let submitted = 0;
  let accepted = 0;
  let rejected = 0;
  let hold = 0;
  let buy = 0;
  let sell = 0;

  for (const r of list) {
    if (r.signal === 'HOLD') hold += 1;
    if (r.signal === 'BUY') buy += 1;
    if (r.signal === 'SELL') sell += 1;
    if (r.signal === 'BUY' || r.signal === 'SELL') actionable += 1;
    if (r.orderId) {
      submitted += 1;
      const oc = r.executionOutcome;
      if (oc && oc.approved === true) accepted += 1;
      else if (oc && oc.approved === false) rejected += 1;
      else if (oc && typeof oc.outcome === 'string' && oc.outcome.includes('reject')) rejected += 1;
    }
  }

  return {
    totalSignals: list.length,
    actionableSignals: actionable,
    holdSignals: hold,
    buySignals: buy,
    sellSignals: sell,
    submittedOrders: submitted,
    acceptedOrders: accepted,
    rejectedOrders: rejected,
  };
}

/**
 * Infer completed trade outcomes from ledger entries.
 * Each SELL entry is a completed (partial or full) exit. Realized delta is
 * derived from consecutive realizedPnlCents on the ledger.
 * @param {object[]} ledgerEntries - from AccountingLedger.getLedger()
 * @returns {{ completedTrades: number, winningTrades: number, losingTrades: number, winRate: number|null, totalFees: number }}
 */
export function summarizeTradesFromLedger(ledgerEntries) {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  let completed = 0;
  let wins = 0;
  let losses = 0;
  let totalFeesCents = 0;
  let prevRealized = 0;

  for (const e of entries) {
    totalFeesCents += e.feeCents || 0;
    if (e.side === 'SELL') {
      completed += 1;
      const delta = (e.realizedPnlCents || 0) - prevRealized;
      if (delta > 0) wins += 1;
      else if (delta < 0) losses += 1;
      // delta === 0 is a flat trade; counted as completed but neither win nor loss
    }
    prevRealized = e.realizedPnlCents || 0;
  }

  return {
    completedTrades: completed,
    winningTrades: wins,
    losingTrades: losses,
    winRate: completed === 0 ? null : wins / completed,
    totalFees: totalFeesCents / 100,
  };
}

/**
 * Maximum drawdown from a chronological equity series.
 * equitySeries: [{ timestamp, equity }] sorted ascending by timestamp.
 * Returns fraction of peak (0–1), or null if insufficient data.
 * @param {object[]} equitySeries
 * @returns {number|null}
 */
export function maxDrawdown(equitySeries) {
  if (!Array.isArray(equitySeries) || equitySeries.length < 2) return null;
  let peak = equitySeries[0].equity;
  let maxDd = 0;
  for (const point of equitySeries) {
    if (!Number.isFinite(point.equity)) return null;
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = (peak - point.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Full performance report.
 * @param {object} opts
 * @param {object[]} opts.records - evaluation records
 * @param {object} opts.ledgerSnapshot - from AccountingLedger.snapshot()
 * @param {object[]} [opts.ledgerEntries]
 * @param {number} [opts.markPrice] - for unrealized and equity
 * @param {object} [opts.mtm] - precomputed markToMarket result
 * @param {object[]} [opts.equitySeries]
 * @returns {object}
 */
export function performanceReport({
  records = [],
  ledgerSnapshot = null,
  ledgerEntries = [],
  markPrice = null,
  mtm = null,
  equitySeries = null,
} = {}) {
  const signals = summarizeSignals(records);
  const trades = summarizeTradesFromLedger(ledgerEntries);

  const realizedPnl = ledgerSnapshot && Number.isFinite(ledgerSnapshot.realizedPnl)
    ? ledgerSnapshot.realizedPnl
    : null;

  let unrealizedPnl = null;
  let equity = null;
  if (mtm) {
    unrealizedPnl = mtm.unrealizedPnl;
    equity = mtm.equity;
  } else if (ledgerSnapshot && markPrice != null && Number.isFinite(markPrice)) {
    // Caller should prefer providing mtm; leave unavailable if not provided
    unrealizedPnl = null;
    equity = ledgerSnapshot.cash; // cash only without position mark
  } else if (ledgerSnapshot) {
    equity = ledgerSnapshot.cash;
  }

  const dd = equitySeries ? maxDrawdown(equitySeries) : null;

  return {
    ...signals,
    ...trades,
    realizedPnl,
    unrealizedPnl,
    equity,
    maxDrawdown: dd,
    openPositionQty: ledgerSnapshot?.positionQty ?? null,
    strategyRealizedPnl: null,
    note: 'Open positions are excluded from completed trade win/loss counts. Strategy-level realized P&L is unavailable (shared aggregate position; no allocation model).',
  };
}

