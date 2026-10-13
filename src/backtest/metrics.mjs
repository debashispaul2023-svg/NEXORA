/**
 * Backtest metrics.
 *
 * Definitions:
 * - startingCapital: configured initial capital
 * - endingCash: ledger cash after all fills
 * - endingPositionQty: open long quantity (0 if flat)
 * - endingEquity: cash + positionQty * finalMark when finalMark is valid; else cash only
 * - equityMode: 'mark_to_market' or 'cash_only'
 * - realizedPnl: from ledger (authoritative)
 * - unrealizedPnl: (finalMark - avgEntry) * positionQty when position open and mark valid; else null
 * - totalFees: sum of feeCents / 100 from ledger
 * - completedTrades: number of SELL fills that reduced a long position (documented exit units, not invented round-trips)
 * - winningTrades / losingTrades / winRate: based on realized P&L delta on those SELL fills; null winRate if no completed trades
 * - maxDrawdown: peak-to-trough decline on the equity series built during the run (fraction of peak)
 * - strategyRealizedPnl: always null (no allocation model for shared positions)
 *
 * Missing or unreliable data → null / unavailable. Never invented.
 * Synthetic test results do not imply profitability.
 */

export function buildBacktestMetrics({
  initialCapital,
  ledgerSnapshot,
  ledgerEntries = [],
  finalMark = null,
  equitySeries = [],
  signals = [],
} = {}) {
  const snap = ledgerSnapshot || { cash: initialCapital, positionQty: 0, avgEntry: 0, realizedPnl: 0 };
  const endingCash = snap.cash;
  const endingPositionQty = snap.positionQty;

  let endingEquity = endingCash;
  let equityMode = 'cash_only';
  let unrealizedPnl = null;
  if (finalMark != null && Number.isFinite(finalMark) && finalMark > 0) {
    endingEquity = endingCash + endingPositionQty * finalMark;
    equityMode = 'mark_to_market';
    if (endingPositionQty > 0 && Number.isFinite(snap.avgEntry)) {
      unrealizedPnl = (finalMark - snap.avgEntry) * endingPositionQty;
    }
  }

  let totalFeesCents = 0;
  let completedTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let breakEvenTrades = 0;
  let prevRealized = 0;
  for (const e of ledgerEntries) {
    totalFeesCents += e.feeCents || 0;
    if (e.side === 'SELL') {
      // A completed trade here is a SELL fill that reduced a long position.
      // It is not a matched round-trip. Break-even SELLs are counted separately.
      completedTrades += 1;
      const delta = (e.realizedPnlCents || 0) - prevRealized;
      if (delta > 0) winningTrades += 1;
      else if (delta < 0) losingTrades += 1;
      else breakEvenTrades += 1;
    }
    prevRealized = e.realizedPnlCents || 0;
  }


  const maxDd = computeMaxDrawdown(equitySeries);

  return {
    startingCapital: initialCapital,
    endingCash,
    endingPositionQty,
    endingEquity,
    equityMode,
    realizedPnl: Number.isFinite(snap.realizedPnl) ? snap.realizedPnl : null,
    unrealizedPnl,
    totalFees: totalFeesCents / 100,
    completedTrades,
    winningTrades,
    losingTrades,
    breakEvenTrades,
    winRate: completedTrades === 0 ? null : winningTrades / completedTrades,
    sampleStatus: completedTrades === 0 ? 'no_completed_trades' : (completedTrades < 5 ? 'insufficient' : 'measured'),
    maxDrawdown: maxDd,
    strategyRealizedPnl: null,
    signalCount: signals.length,
    actionableSignals: signals.filter((s) => s.actionable).length,
    note: 'Completed trades are SELL fills that reduced a long position. Strategy-level P&L is unavailable. Synthetic results do not imply profitability.',
  };
}

function computeMaxDrawdown(equitySeries) {
  if (!Array.isArray(equitySeries) || equitySeries.length < 2) return null;
  let peak = equitySeries[0].equity;
  let maxDd = 0;
  for (const p of equitySeries) {
    if (!Number.isFinite(p.equity)) return null;
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}
