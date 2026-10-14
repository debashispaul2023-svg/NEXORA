import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { MarketDataError } from '../errors.mjs';

/**
 * Local JSON cache for retrieved market data.
 * Stores provenance and retrieval time. Does not claim real-time freshness.
 */

export const DEFAULT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function cachePath(provider, symbol) {
  const safeSymbol = String(symbol || '').replace(/[^A-Za-z0-9._-]/g, '_');
  const safeProvider = String(provider || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return resolveProjectPath(join('data', 'market', safeProvider, `${safeSymbol}.json`));
}

/**
 * Read a cache record if present.
 * @returns {object|null}
 */
export function readMarketCache(provider, symbol) {
  const path = cachePath(provider, symbol);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new MarketDataError('Market cache is unreadable', { path, cause: err.message });
  }
}

/**
 * Write a cache record with provenance.
 */
export function writeMarketCache(record) {
  if (!record || !record.provider || !record.symbol) {
    throw new MarketDataError('Cache record must include provider and symbol');
  }
  const path = cachePath(record.provider, record.symbol);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
  return { saved: true, path };
}

/**
 * Decide whether a cache record is still fresh.
 * @param {object|null} record
 * @param {number} freshnessMs
 * @param {number} [nowMs]
 */
export function isCacheFresh(record, freshnessMs = DEFAULT_FRESHNESS_MS, nowMs = Date.now()) {
  if (!record || !Number.isFinite(record.retrievedAt)) return false;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) return false;
  return (nowMs - record.retrievedAt) <= freshnessMs;
}
