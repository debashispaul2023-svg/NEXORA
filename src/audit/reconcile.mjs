import { loadEvents } from './events.mjs';
import { loadEquitySnapshots } from './equity.mjs';

/**
 * Read-only audit and reconciliation utility.
 *
 * Does not modify, delete, or rewrite historical records.
 * Does not replace the authoritative accounting ledger.
 *
 * Reports discrepancies with classifications. A mismatch does not
 * automatically prove corruption.
 *
 * Full historical reconstruction from the audit log alone is not
 * supported in this phase (ledger remains authoritative).
 */

/**
 * @param {object} [opts]
 * @param {object} [opts.portfolioSnapshot] - current ledger.snapshot() if available
 * @returns {object} reconciliation report
 */
export function reconcileAudit({ portfolioSnapshot = null } = {}) {
  const eventsLoaded = loadEvents();
  const equityLoaded = loadEquitySnapshots();

  const byType = {};
  const seenIds = new Set();
  let duplicateIds = 0;
  const orders = new Map(); // orderId → { submitted, approved, rejected, filled, accounted }

  for (const e of eventsLoaded.events) {
    byType[e.eventType] = (byType[e.eventType] || 0) + 1;
    if (seenIds.has(e.eventId)) duplicateIds += 1;
    else seenIds.add(e.eventId);

    if (e.orderId) {
      if (!orders.has(e.orderId)) {
        orders.set(e.orderId, { submitted: false, approved: false, rejected: false, filled: false, accounted: false });
      }
      const o = orders.get(e.orderId);
      if (e.eventType === 'ORDER_SUBMITTED') o.submitted = true;
      if (e.eventType === 'ORDER_APPROVED') o.approved = true;
      if (e.eventType === 'ORDER_REJECTED') o.rejected = true;
      if (e.eventType === 'ORDER_FILLED') o.filled = true;
      if (e.eventType === 'ACCOUNTING_APPLIED') o.accounted = true;
    }
  }

  const ordersWithoutTerminal = [];
  const fillsWithoutAccounting = [];
  for (const [id, o] of orders) {
    const terminal = o.rejected || o.filled;
    if (!terminal) ordersWithoutTerminal.push(id);
    if (o.filled && !o.accounted) fillsWithoutAccounting.push(id);
  }

  // Chronological anomalies in equity (timestamp decreases)
  const equity = equityLoaded.snapshots;
  const timestampAnomalies = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i].timestamp < equity[i - 1].timestamp) {
      timestampAnomalies.push({ index: i, prev: equity[i - 1].timestamp, curr: equity[i].timestamp });
    }
  }

  const report = {
    totalEvents: eventsLoaded.events.length,
    eventsByType: byType,
    malformedEvents: eventsLoaded.malformed,
    unsupportedEventSchemas: eventsLoaded.unsupported,
    duplicateEventIds: eventsLoaded.duplicateEventIds || 0,
    ordersWithoutTerminalEvent: ordersWithoutTerminal,
    fillsWithoutAccountingEvent: fillsWithoutAccounting,
    equitySnapshotCount: equity.length,
    equityMalformed: equityLoaded.malformed,
    equityUnsupported: equityLoaded.unsupported,
    equityTimestampAnomalies: timestampAnomalies,
    portfolioProvided: !!portfolioSnapshot,
    notes: [
      'Audit log is not the authoritative accounting ledger.',
      'Mismatches are classified, not auto-repaired.',
      'Full historical reconstruction from audit alone is not supported in this phase.',
    ],
  };

  if (portfolioSnapshot) {
    report.portfolioCash = portfolioSnapshot.cash;
    report.portfolioPositionQty = portfolioSnapshot.positionQty;
    // Soft check: if last equity snapshot exists, compare cash (informational)
    if (equity.length) {
      const last = equity[equity.length - 1];
      report.lastEquityCash = last.cash;
      report.cashMismatch = Math.abs(last.cash - portfolioSnapshot.cash) > 0.01;
    }
  }

  return report;
}
