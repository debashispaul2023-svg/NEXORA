import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveProjectPath } from '../paths.mjs';
import { AuditError } from '../errors.mjs';
import { withProcessLock } from './lock.mjs';



/**
 * Append-oriented JSONL event audit trail.
 *
 * Path: data/audit/events.jsonl
 * Schema version: 1
 *
 * Durability: appendFileSync is used. This is NOT tamper-proof and is NOT
 * fully crash-atomic across multiple files. A process crash during append
 * may leave a partial final line, which is detected and reported as malformed.
 *
 * Single-writer requirement: concurrent writers are unsupported.
 *
 * Duplicate eventId: rejected (existing event kept; no overwrite).
 * Malformed lines: skipped, counted, and reported; history is never truncated.
 * Unsupported schema: skipped and counted.
 *
 * No secrets or credentials are stored.
 */

export const EVENT_SCHEMA_VERSION = 1;
export const EVENTS_FILENAME = 'events.jsonl';

export const EVENT_TYPES = Object.freeze([
  'SIGNAL_RECORDED',
  'ORDER_SUBMITTED',
  'ORDER_REJECTED',
  'ORDER_APPROVED',
  'ORDER_FILLED',
  'ACCOUNTING_APPLIED',
  'EQUITY_SNAPSHOT_RECORDED',
  'RECOVERY_COMPLETED',
  'RECOVERY_FAILED',
  'TRANSACTION_ROLLED_BACK',
  'AUDIT_FAILURE',
]);

/**
 * Structured rejection stages (payload.stage).
 * ORDER_REJECTED is used for pre-execution and execution-time rejections.
 * TRANSACTION_ROLLED_BACK is used when accounting was applied then undone.
 * AUDIT_FAILURE is used when a financial outcome occurred but audit write failed.
 */
export const REJECTION_STAGES = Object.freeze([
  'risk',
  'execution',
  'accounting',
  'rollback',
  'audit',
]);


function eventsPath() {
  return resolveProjectPath(join('data', 'audit', EVENTS_FILENAME));
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Validate and normalize an event.
 * @param {object} event
 * @returns {object}
 */
export function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new AuditError('Event must be an object');
  }
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new AuditError(`Unsupported event schema version: ${event.schemaVersion}`);
  }
  if (typeof event.eventId !== 'string' || !event.eventId.trim()) {
    throw new AuditError('eventId is required');
  }
  if (!EVENT_TYPES.includes(event.eventType)) {
    throw new AuditError(`Unknown eventType: ${event.eventType}`);
  }
  if (!Number.isFinite(event.occurredAt)) {
    throw new AuditError('occurredAt must be a finite UTC ms timestamp');
  }
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: event.eventId.trim(),
    eventType: event.eventType,
    occurredAt: Math.floor(event.occurredAt),
    recordedAt: event.recordedAt || new Date().toISOString(),
    source: event.source || 'unknown',
    correlationId: event.correlationId || null,
    orderId: event.orderId || null,
    fillId: event.fillId || null,
    strategyId: event.strategyId || null,
    strategyVersion: event.strategyVersion || null,
    candleTimestamp: event.candleTimestamp ?? null,
    payload: event.payload || {},
  };
}

/**
 * Append a validated event. Rejects duplicates by eventId.
 * Serialized within this process via withProcessLock.
 * @param {object} event
 * @returns {Promise<{ appended: boolean, event: object }>}
 */
export async function appendEvent(event) {
  return withProcessLock(() => appendEventUnlocked(event));
}

function appendEventUnlocked(event) {
  const normalized = validateEvent(event);
  const existing = loadEvents();
  if (existing.events.some((e) => e.eventId === normalized.eventId)) {
    return { appended: false, event: normalized, duplicate: true };
  }

  const path = eventsPath();
  ensureDir(path);
  const line = JSON.stringify(normalized) + '\n';
  let written = false;
  let lastErr;
  for (let attempt = 0; attempt < 8 && !written; attempt++) {
    try {
      appendFileSync(path, line, 'utf8');
      written = true;
    } catch (err) {
      lastErr = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }

  if (!written) {
    throw new AuditError(`Failed to append event: ${lastErr.message}`, { code: lastErr.code });
  }
  return { appended: true, event: normalized, duplicate: false };
}



/**
 * Load and parse the events JSONL file.
 * Malformed lines and unsupported schemas are skipped and counted.
 * Partial final line is treated as malformed.
 * @returns {{ events: object[], malformed: number, unsupported: number, fileSize: number }}
 */
export function loadEvents() {
  const path = eventsPath();
  if (!existsSync(path)) {
    return { events: [], malformed: 0, unsupported: 0, fileSize: 0 };
  }

  const raw = readFileSync(path, 'utf8');
  const fileSize = statSync(path).size;
  const lines = raw.split('\n');
  // Drop trailing empty from final newline
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const events = [];
  let malformed = 0;
  let unsupported = 0;

  for (const line of lines) {
    if (!line.trim()) {
      malformed += 1;
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj.schemaVersion !== EVENT_SCHEMA_VERSION) {
      unsupported += 1;
      continue;
    }
    try {
      events.push(validateEvent(obj));
    } catch {
      malformed += 1;
    }
  }

  return { events, malformed, unsupported, fileSize };
}

/**
 * Observability helpers.
 */
export function eventStats() {
  const loaded = loadEvents();
  return {
    total: loaded.events.length,
    malformed: loaded.malformed,
    unsupported: loaded.unsupported,
    fileSize: loaded.fileSize,
  };
}
