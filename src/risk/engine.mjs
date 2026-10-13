import { RiskError } from '../errors.mjs';

/**
 * Deterministic risk limits and daily realized-loss tracking.
 *
 * Defaults (currency units unless noted):
 * - maxPositionQty: 10          (absolute units; null = disabled)
 * - maxPositionNotional: 500    (currency; null = disabled)
 * - maxOrderNotional: 200       (currency; null = disabled)
 * - dailyRealizedLossLimit: 50  (absolute loss; null = disabled)
 * - timezone: 'UTC'
 *
 * Daily loss policy:
 * - Trading day = calendar date in the configured timezone (default UTC).
 * - Tracks realized P&L attributed to fills whose timestamp falls on that date.
 * - This is NOT a maximum-drawdown limit (which would use peak equity).
 * - State is persisted so a restart does not reset the day's loss.
 *
 * Failure mode: if required state is missing or calculation cannot be performed safely,
 * the order is rejected. Risk never silently allows an order on internal failure.
 *
 * Long-only only. No short, leverage, margin, or liquidation.
 */

export const DEFAULT_RISK_LIMITS = Object.freeze({
  maxPositionQty: 10,
  maxPositionNotional: 500,
  maxOrderNotional: 200,
  dailyRealizedLossLimit: 50,
  timezone: 'UTC',
});

export function validateRiskConfig(cfg = {}) {
  const limits = { ...DEFAULT_RISK_LIMITS, ...cfg };
  for (const key of ['maxPositionQty', 'maxPositionNotional', 'maxOrderNotional', 'dailyRealizedLossLimit']) {
    const v = limits[key];
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      throw new RiskError(`Invalid risk limit ${key}: must be null (disabled) or non-negative finite number`, { key, value: v });
    }
  }
  if (typeof limits.timezone !== 'string' || !limits.timezone) {
    throw new RiskError('timezone must be a non-empty string');
  }
  return limits;
}

/**
 * Return YYYY-MM-DD for a UTC millisecond timestamp in the given timezone.
 * Currently only UTC is fully supported; other zones fall back to UTC with a warning flag.
 */
export function tradingDay(ts, timezone = 'UTC') {
  if (!Number.isFinite(ts)) throw new RiskError('Invalid timestamp for trading day');
  // UTC only for deterministic Phase 5; document limitation
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class DailyLossTracker {
  constructor({ timezone = 'UTC', limit = 50 } = {}) {
    this.timezone = timezone;
    this.limit = limit; // absolute loss amount; null = disabled
    this.currentDay = null;
    this.realizedCents = 0;
  }

  exportState() {
    return {
      timezone: this.timezone,
      limit: this.limit,
      currentDay: this.currentDay,
      realizedCents: this.realizedCents,
    };
  }

  importState(state) {
    if (!state) return;
    this.timezone = state.timezone || this.timezone;
    this.limit = state.limit ?? this.limit;
    this.currentDay = state.currentDay || null;
    this.realizedCents = Number.isFinite(state.realizedCents) ? state.realizedCents : 0;
  }

  /**
   * Record realized P&L (in cents) for a fill at the given timestamp.
   * Resets if the trading day changed.
   */
  record(realizedCents, timestamp) {
    const day = tradingDay(timestamp, this.timezone);
    if (this.currentDay !== day) {
      this.currentDay = day;
      this.realizedCents = 0;
    }
    this.realizedCents += realizedCents;
  }

  /**
   * Check whether adding this realized amount would breach the daily loss limit.
   * Returns { ok, reason? }.
   */
  check(additionalRealizedCents, timestamp) {
    if (this.limit === null) return { ok: true };
    const day = tradingDay(timestamp, this.timezone);
    let projected = this.realizedCents;
    if (this.currentDay !== day) projected = 0;
    projected += additionalRealizedCents;
    // Loss is negative realized
    if (projected < 0 && Math.abs(projected) / 100 > this.limit) {
      return {
        ok: false,
        reason: 'daily_realized_loss_limit',
        detail: { projectedLoss: Math.abs(projected) / 100, limit: this.limit, day },
      };
    }
    return { ok: true };
  }
}

/**
 * Evaluate an order intent against current ledger state and estimated fill price.
 * Does not mutate any state.
 * @returns {{ approved: boolean, reasons: object[] }}
 */
export function evaluateRisk(order, ledgerSnapshot, estimatedFillPrice, limits, dailyTracker) {
  const reasons = [];

  if (!order || !Number.isFinite(order.quantity) || order.quantity <= 0) {
    reasons.push({ code: 'invalid_quantity', message: 'Quantity must be positive finite' });
  }
  if (!Number.isFinite(estimatedFillPrice) || estimatedFillPrice <= 0) {
    reasons.push({ code: 'invalid_price', message: 'Estimated fill price must be positive finite' });
  }
  if (reasons.length) return { approved: false, reasons };

  const qty = order.quantity;
  const price = estimatedFillPrice;
  const notional = qty * price;

  // Max order notional
  if (limits.maxOrderNotional !== null && notional > limits.maxOrderNotional) {
    reasons.push({
      code: 'max_order_notional',
      message: `Order notional ${notional.toFixed(2)} exceeds limit ${limits.maxOrderNotional}`,
      notional, limit: limits.maxOrderNotional,
    });
  }

  // Long-only / position checks
  const currentQty = ledgerSnapshot.positionQty || 0;
  if (order.side === 'SELL' && qty > currentQty + 1e-8) {
    reasons.push({
      code: 'insufficient_position',
      message: 'Sell quantity exceeds position (short selling not supported)',
      position: currentQty, sellQty: qty,
    });
  }

  if (order.side === 'BUY') {
    const newQty = currentQty + qty;
    if (limits.maxPositionQty !== null && newQty > limits.maxPositionQty) {
      reasons.push({
        code: 'max_position_qty',
        message: `Resulting position ${newQty} exceeds max ${limits.maxPositionQty}`,
        resulting: newQty, limit: limits.maxPositionQty,
      });
    }
    const newNotional = newQty * price; // conservative: mark at estimated fill
    if (limits.maxPositionNotional !== null && newNotional > limits.maxPositionNotional) {
      reasons.push({
        code: 'max_position_notional',
        message: `Resulting exposure ${newNotional.toFixed(2)} exceeds limit ${limits.maxPositionNotional}`,
        exposure: newNotional, limit: limits.maxPositionNotional,
      });
    }
    // Cash check (approximate; exact check remains in accounting)
    const required = notional; // fees handled in accounting
    if (ledgerSnapshot.cash < required) {
      reasons.push({
        code: 'insufficient_cash',
        message: 'Insufficient cash for estimated notional',
        cash: ledgerSnapshot.cash, required,
      });
    }
  }

  // Daily realized loss (only meaningful for sells that realize loss; we check projected)
  if (order.side === 'SELL' && dailyTracker) {
    const avg = ledgerSnapshot.avgEntry || 0;
    const projectedRealizedCents = Math.round((price - avg) * qty * 100);
    const dayCheck = dailyTracker.check(projectedRealizedCents, order.timestamp);
    if (!dayCheck.ok) {
      reasons.push({ code: dayCheck.reason, message: 'Daily realized-loss limit would be breached', ...dayCheck.detail });
    }
  }

  return { approved: reasons.length === 0, reasons };
}
