import { ExecutionError } from '../errors.mjs';

/**
 * Paper order representation and validation.
 * Supported order type in this phase: MARKET only.
 * Partial fills, limit, stop, short, leverage, and margin are NOT supported.
 */

export const ORDER_TYPES = Object.freeze(['MARKET']);
export const ORDER_SIDES = Object.freeze(['BUY', 'SELL']);
export const ORDER_STATES = Object.freeze(['pending', 'filled', 'rejected']);

/**
 * Validate and normalize an order intent.
 * @param {object} intent
 * @returns {object} normalized order (state = pending)
 */
export function validateOrderIntent(intent) {
  if (!intent || typeof intent !== 'object') {
    throw new ExecutionError('Order intent must be an object');
  }

  const id = String(intent.id || '').trim();
  if (!id) {
    throw new ExecutionError('Order id is required');
  }

  const type = String(intent.type || '').toUpperCase();
  if (!ORDER_TYPES.includes(type)) {
    throw new ExecutionError(`Unsupported order type: ${type}. Supported: ${ORDER_TYPES.join(', ')}`, { type });
  }

  const side = String(intent.side || '').toUpperCase();
  if (!ORDER_SIDES.includes(side)) {
    throw new ExecutionError(`Invalid side: ${side}. Must be BUY or SELL`, { side });
  }

  const quantity = Number(intent.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ExecutionError('Quantity must be a positive finite number', { quantity });
  }

  const timestamp = Number(intent.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new ExecutionError('Order timestamp must be a finite number (UTC ms)', { timestamp });
  }

  return {
    id,
    type,
    side,
    quantity: roundQty(quantity),
    timestamp: Math.floor(timestamp),
    state: 'pending',
    symbol: intent.symbol || 'SYNTH',
  };
}

function roundQty(q) {
  return Math.round(q * 1e8) / 1e8;
}

/**
 * Permitted state transitions.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  pending: ['filled', 'rejected'],
  filled: [],
  rejected: [],
});

export function assertTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new ExecutionError(`Invalid order state transition: ${from} → ${to}`);
  }
}
