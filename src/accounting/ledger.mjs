import { AccountingError } from '../errors.mjs';

/**
 * Paper accounting ledger (in-memory, long-only).
 *
 * Money is tracked in integer cents to avoid uncontrolled floating-point drift.
 * Quantities are rounded to 8 decimal places.
 *
 * Formulas:
 * - Cash starts at initialCapitalCents.
 * - BUY: cash -= round(fillPrice * quantity * 100) + feeCents; position qty += quantity; avgEntry updated.
 * - SELL: cash += round(fillPrice * quantity * 100) - feeCents; realizedPnl += (fillPrice - avgEntry) * quantity * 100 (cents);
 *          position qty -= quantity; if qty reaches 0, avgEntry = 0.
 * - Unrealized P&L = (markPrice - avgEntry) * positionQty * 100 (cents).
 * - Equity = cash + (positionQty * markPrice * 100) (cents).
 *
 * Invariants:
 * - Cash never negative.
 * - Position quantity never negative.
 * - Rejected operations leave state unchanged.
 * - No short selling, leverage, margin, or liquidation.
 *
 * Persistence: in-memory only. Restart recovery is NOT implemented.
 */

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
  return cents / 100;
}

function roundQty(q) {
  return Math.round(Number(q) * 1e8) / 1e8;
}

export class AccountingLedger {
  /**
   * @param {object} opts
   * @param {number} opts.initialCapital - in currency units (e.g. 1000)
   * @param {number} [opts.feeBps=0] - fee in basis points applied on notional
   */
  constructor({ initialCapital, feeBps = 0 } = {}) {
    if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new AccountingError('initialCapital must be a positive finite number');
    }
    if (!Number.isFinite(feeBps) || feeBps < 0) {
      throw new AccountingError('feeBps must be a non-negative finite number');
    }
    this.initialCapitalCents = toCents(initialCapital);
    this.feeBps = feeBps;
    this.cashCents = this.initialCapitalCents;
    this.positionQty = 0;
    this.avgEntry = 0;
    this.realizedPnlCents = 0;
    this.ledger = []; // append-only records
    this.processedFills = new Set(); // idempotency by fill key
  }

  /**
   * Apply a filled order. Rejected orders must not be passed here.
   * Idempotent on (orderId).
   * @param {object} fillResult - { order, fill } from PaperExecutionEngine
   * @returns {object} snapshot after application
   */
  applyFill(fillResult) {
    if (!fillResult?.order || fillResult.order.state !== 'filled' || !fillResult.fill) {
      throw new AccountingError('Only filled orders with a fill may be applied');
    }

    const { order, fill } = fillResult;
    const key = order.id;
    if (this.processedFills.has(key)) {
      return this.snapshot(); // idempotent, no change
    }

    const qty = roundQty(fill.quantity);
    const price = Number(fill.price);
    if (!Number.isFinite(price) || price <= 0 || qty <= 0) {
      throw new AccountingError('Invalid fill price or quantity', { price, qty });
    }

    const notionalCents = toCents(price * qty);
    const feeCents = Math.round(notionalCents * (this.feeBps / 10000));

    if (order.side === 'BUY') {
      const totalCost = notionalCents + feeCents;
      if (this.cashCents < totalCost) {
        throw new AccountingError('Insufficient cash for buy', {
          cash: fromCents(this.cashCents),
          required: fromCents(totalCost),
        });
      }
      // Update average entry
      const newQty = roundQty(this.positionQty + qty);
      const newAvg = newQty === 0 ? 0 : ((this.avgEntry * this.positionQty) + (price * qty)) / newQty;
      this.cashCents -= totalCost;
      this.positionQty = newQty;
      this.avgEntry = newAvg;
    } else if (order.side === 'SELL') {
      if (qty > this.positionQty + 1e-8) {
        throw new AccountingError('Insufficient position quantity for sell (short selling not supported)', {
          position: this.positionQty,
          sellQty: qty,
        });
      }
      const proceeds = notionalCents - feeCents;
      const realized = Math.round((price - this.avgEntry) * qty * 100);
      this.cashCents += proceeds;
      this.realizedPnlCents += realized;
      this.positionQty = roundQty(this.positionQty - qty);
      if (this.positionQty === 0) this.avgEntry = 0;
    } else {
      throw new AccountingError(`Unsupported side: ${order.side}`);
    }

    if (this.cashCents < 0) {
      throw new AccountingError('Invariant violated: cash became negative');
    }
    if (this.positionQty < 0) {
      throw new AccountingError('Invariant violated: position quantity became negative');
    }

    this.processedFills.add(key);
    this.ledger.push({
      orderId: order.id,
      side: order.side,
      quantity: qty,
      price,
      feeCents,
      cashAfterCents: this.cashCents,
      positionAfter: this.positionQty,
      realizedPnlCents: this.realizedPnlCents,
      timestamp: fill.timestamp,
    });

    return this.snapshot();
  }

  /**
   * Mark-to-market equity and unrealized P&L.
   * @param {number} markPrice
   * @returns {object}
   */
  markToMarket(markPrice) {
    const price = Number(markPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw new AccountingError('Invalid mark price', { markPrice });
    }
    const unrealizedCents = Math.round((price - this.avgEntry) * this.positionQty * 100);
    const positionValueCents = toCents(price * this.positionQty);
    const equityCents = this.cashCents + positionValueCents;
    return {
      markPrice: price,
      unrealizedPnl: fromCents(unrealizedCents),
      equity: fromCents(equityCents),
      cash: fromCents(this.cashCents),
      positionQty: this.positionQty,
      avgEntry: this.avgEntry,
      realizedPnl: fromCents(this.realizedPnlCents),
    };
  }

  snapshot() {
    return {
      cash: fromCents(this.cashCents),
      positionQty: this.positionQty,
      avgEntry: this.avgEntry,
      realizedPnl: fromCents(this.realizedPnlCents),
      initialCapital: fromCents(this.initialCapitalCents),
      ledgerLength: this.ledger.length,
    };
  }

  getLedger() {
    return [...this.ledger];
  }

  /**
   * Export authoritative state for persistence.
   * Unrealized P&L and equity are derived and not stored.
   */
  exportState() {
    return {
      initialCapitalCents: this.initialCapitalCents,
      feeBps: this.feeBps,
      cashCents: this.cashCents,
      positionQty: this.positionQty,
      avgEntry: this.avgEntry,
      realizedPnlCents: this.realizedPnlCents,
      ledger: [...this.ledger],
      processedFills: [...this.processedFills],
    };
  }

  /**
   * Restore from exported state. Validates invariants.
   * @param {object} state
   */
  importState(state) {
    if (!state || typeof state !== 'object') {
      throw new AccountingError('Invalid ledger state');
    }
    if (!Number.isFinite(state.cashCents) || state.cashCents < 0) {
      throw new AccountingError('Restored cash invariant violated', { cashCents: state.cashCents });
    }
    if (!Number.isFinite(state.positionQty) || state.positionQty < 0) {
      throw new AccountingError('Restored position invariant violated', { positionQty: state.positionQty });
    }
    this.initialCapitalCents = state.initialCapitalCents;
    this.feeBps = state.feeBps;
    this.cashCents = state.cashCents;
    this.positionQty = state.positionQty;
    this.avgEntry = state.avgEntry || 0;
    this.realizedPnlCents = state.realizedPnlCents || 0;
    this.ledger = Array.isArray(state.ledger) ? [...state.ledger] : [];
    this.processedFills = new Set(state.processedFills || []);
  }
}

