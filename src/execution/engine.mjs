import { ExecutionError } from '../errors.mjs';
import { validateCandleSeries } from '../market-data/candle.mjs';
import { validateOrderIntent, assertTransition } from './order.mjs';

/**
 * Deterministic paper execution engine (in-memory).
 *
 * Fill model (documented limitation):
 * - MARKET orders only.
 * - Execution candle = first candle whose timestamp >= order.timestamp.
 * - Fill price = that candle's close, adjusted by configurable slippage.
 * - BUY slippage increases the fill price; SELL slippage decreases it.
 * - Never uses candles after the execution candle.
 * - A synthetic fill is not a real market execution guarantee.
 *
 * Partial fills are NOT supported. Orders are all-or-nothing.
 * Idempotent: submitting the same order id twice returns the original result without re-applying.
 */

const DEFAULT_SLIPPAGE_BPS = 0; // basis points

export class PaperExecutionEngine {
  /**
   * @param {object} opts
   * @param {number} [opts.slippageBps=0] - simulated slippage in basis points
   */
  constructor({ slippageBps = DEFAULT_SLIPPAGE_BPS } = {}) {
    if (!Number.isFinite(slippageBps) || slippageBps < 0) {
      throw new ExecutionError('slippageBps must be a non-negative finite number');
    }
    this.slippageBps = slippageBps;
    this.orders = new Map(); // id → final order record
  }

  /**
   * Submit an order against a validated candle series.
   * @param {object} intent
   * @param {object[]} candles - must be ordered ascending
   * @returns {object} order result { order, fill? }
   */
  submit(intent, candles) {
    const order = validateOrderIntent(intent);

    // Idempotency
    if (this.orders.has(order.id)) {
      return this.orders.get(order.id);
    }

    const series = validateCandleSeries(candles);
    if (series.length === 0) {
      return this._reject(order, 'No candles available for execution');
    }

    // Find execution candle: first with timestamp >= order.timestamp
    const execCandle = series.find((c) => c.timestamp >= order.timestamp);
    if (!execCandle) {
      return this._reject(order, 'No candle at or after order timestamp (would require future data)');
    }

    const rawPrice = execCandle.close;
    const slip = this.slippageBps / 10000;
    let fillPrice;
    if (order.side === 'BUY') {
      fillPrice = rawPrice * (1 + slip);
    } else {
      fillPrice = rawPrice * (1 - slip);
    }
    fillPrice = roundPrice(fillPrice);

    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      return this._reject(order, 'Invalid fill price computed', { fillPrice });
    }

    assertTransition('pending', 'filled');
    const filled = {
      ...order,
      state: 'filled',
      fillPrice,
      fillTimestamp: execCandle.timestamp,
      executionCandleTimestamp: execCandle.timestamp,
      slippageBps: this.slippageBps,
      source: execCandle.source || 'unknown',
    };

    const result = { order: filled, fill: { price: fillPrice, quantity: order.quantity, timestamp: execCandle.timestamp } };
    this.orders.set(order.id, result);
    return result;
  }

  _reject(order, reason, details = null) {
    assertTransition('pending', 'rejected');
    const rejected = {
      ...order,
      state: 'rejected',
      rejectReason: reason,
      details,
    };
    const result = { order: rejected, fill: null };
    this.orders.set(order.id, result);
    return result;
  }

  getOrder(id) {
    return this.orders.get(id) || null;
  }

  exportState() {
    const orders = {};
    for (const [id, result] of this.orders) {
      orders[id] = result;
    }
    return { slippageBps: this.slippageBps, orders };
  }

  importState(state) {
    if (!state || typeof state !== 'object') {
      throw new ExecutionError('Invalid execution state');
    }
    this.slippageBps = state.slippageBps ?? this.slippageBps;
    this.orders = new Map(Object.entries(state.orders || {}));
  }
}


function roundPrice(p) {
  return Math.round(p * 10000) / 10000;
}
