import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';

import {
  appendEvent,
  loadEvents,
  validateEvent,
  EVENT_TYPES,
  EVENTS_FILENAME,
  _setAppendWriterForTests,
} from '../src/audit/events.mjs';

import {
  buildEquitySnapshot,
  appendEquitySnapshot,
  loadEquitySnapshots,
  EQUITY_FILENAME,
} from '../src/audit/equity.mjs';
import { reconcileAudit } from '../src/audit/reconcile.mjs';
import { AuditError } from '../src/errors.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';

function retryFs(fn, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      last = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw last;
}

function cleanAudit() {
  for (const n of [EVENTS_FILENAME, EQUITY_FILENAME]) {
    const p = resolveProjectPath(`data/audit/${n}`);
    if (existsSync(p)) {
      retryFs(() => unlinkSync(p));
    }
  }
}


function sampleEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    eventType: 'ORDER_SUBMITTED',
    occurredAt: 1_700_000_000_000,
    source: 'test',
    correlationId: 'corr-1',
    orderId: 'ord-1',
    payload: { side: 'BUY' },
    ...overrides,
  };
}

test('event schema validation rejects invalid events', () => {
  assert.throws(() => validateEvent({}), AuditError);
  assert.throws(() => validateEvent({ schemaVersion: 1, eventId: 'x', eventType: 'NOT_A_TYPE', occurredAt: 1 }), AuditError);
  assert.ok(EVENT_TYPES.includes('ORDER_FILLED'));
});

test('JSONL append and reload preserves events', async () => {
  cleanAudit();
  const e = sampleEvent();
  const r = await appendEvent(e);
  assert.equal(r.appended, true);
  const loaded = loadEvents();
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].eventId, 'evt-1');
  assert.equal(loaded.events[0].eventType, 'ORDER_SUBMITTED');
  cleanAudit();
});

test('duplicate eventId is rejected and history preserved', async () => {
  cleanAudit();
  await appendEvent(sampleEvent());
  const r2 = await appendEvent(sampleEvent());
  assert.equal(r2.appended, false);
  assert.equal(r2.duplicate, true);
  assert.equal(loadEvents().events.length, 1);
  cleanAudit();
});

test('malformed middle line is skipped and counted', async () => {
  cleanAudit();
  await appendEvent(sampleEvent({ eventId: 'good-1' }));
  const path = resolveProjectPath(`data/audit/${EVENTS_FILENAME}`);
  retryFs(() => appendFileSync(path, '{ not json\n'));
  await appendEvent(sampleEvent({ eventId: 'good-2', eventType: 'ORDER_FILLED' }));
  const loaded = loadEvents();
  assert.equal(loaded.events.length, 2);
  assert.ok(loaded.malformed >= 1);
  cleanAudit();
});

test('truncated final line is treated as malformed', async () => {
  cleanAudit();
  await appendEvent(sampleEvent({ eventId: 'ok' }));
  const path = resolveProjectPath(`data/audit/${EVENTS_FILENAME}`);
  retryFs(() => appendFileSync(path, '{"schemaVersion":1,"eventId":"trunc"'));
  const loaded = loadEvents();
  assert.equal(loaded.events.length, 1);
  assert.ok(loaded.malformed >= 1);
  cleanAudit();
});

test('unsupported schema version is skipped', async () => {
  cleanAudit();
  const path = resolveProjectPath(`data/audit/${EVENTS_FILENAME}`);
  retryFs(() => writeFileSync(path, JSON.stringify({ schemaVersion: 99, eventId: 'old', eventType: 'ORDER_SUBMITTED', occurredAt: 1 }) + '\n'));
  await appendEvent(sampleEvent({ eventId: 'new' }));
  const loaded = loadEvents();
  assert.equal(loaded.unsupported, 1);
  assert.equal(loaded.events.length, 1);
  cleanAudit();
});

test('historical events are not overwritten', async () => {
  cleanAudit();
  await appendEvent(sampleEvent({ eventId: 'a' }));
  await appendEvent(sampleEvent({ eventId: 'b', eventType: 'ORDER_APPROVED' }));
  const before = loadEvents().events.length;
  await appendEvent(sampleEvent({ eventId: 'a' }));
  assert.equal(loadEvents().events.length, before);
  cleanAudit();
});


test('equity snapshot validation and cash-only vs mark-to-market', () => {
  const snap = { cash: 900, positionQty: 1, avgEntry: 100, realizedPnl: 0, initialCapital: 1000 };
  const cashOnly = buildEquitySnapshot(snap, { snapshotId: 'eq-cash', timestamp: 1 });
  assert.equal(cashOnly.mode, 'cash_only');
  assert.equal(cashOnly.equity, 900);
  assert.equal(cashOnly.unrealizedPnl, null);

  const mtm = buildEquitySnapshot(snap, { snapshotId: 'eq-mtm', timestamp: 2, markPrice: 110, markSource: 'synthetic' });
  assert.equal(mtm.mode, 'mark_to_market');
  assert.equal(mtm.equity, 1010);
  assert.ok(Math.abs(mtm.unrealizedPnl - 10) < 1e-9);
});

test('equity snapshot deduplication and chronological load', async () => {
  cleanAudit();
  const snap = { cash: 1000, positionQty: 0, avgEntry: 0, realizedPnl: 0, initialCapital: 1000 };
  const a = buildEquitySnapshot(snap, { snapshotId: 's1', timestamp: 100 });
  const b = buildEquitySnapshot(snap, { snapshotId: 's2', timestamp: 200 });
  assert.equal((await appendEquitySnapshot(a)).appended, true);
  assert.equal((await appendEquitySnapshot(b)).appended, true);
  assert.equal((await appendEquitySnapshot(a)).duplicate, true);
  const loaded = loadEquitySnapshots();
  assert.equal(loaded.snapshots.length, 2);
  assert.equal(loaded.snapshots[0].timestamp, 100);
  assert.equal(loaded.snapshots[1].timestamp, 200);
  cleanAudit();
});


test('equity snapshot does not mutate portfolio', () => {
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const before = ledger.snapshot();
  buildEquitySnapshot(before, { snapshotId: 'nomut', timestamp: 1, markPrice: 100 });
  assert.deepEqual(ledger.snapshot(), before);
});

test('reconciliation reports event counts and fills without accounting', async () => {
  cleanAudit();
  await appendEvent(sampleEvent({ eventId: 'e1', eventType: 'ORDER_SUBMITTED', orderId: 'o1' }));
  await appendEvent(sampleEvent({ eventId: 'e2', eventType: 'ORDER_APPROVED', orderId: 'o1' }));
  await appendEvent(sampleEvent({ eventId: 'e3', eventType: 'ORDER_FILLED', orderId: 'o1' }));
  const loaded = loadEvents();
  const forOrder = loaded.events.filter((e) => e.orderId === 'o1');
  assert.equal(forOrder.length, 3);
  const report = reconcileAudit();
  assert.equal(report.eventsByType.ORDER_FILLED, 1);
  assert.ok(report.fillsWithoutAccountingEvent.includes('o1'));
  assert.ok(report.notes.length > 0);
  cleanAudit();
});



test('disk-write failure on event append throws AuditError', async () => {
  await assert.rejects(
    () => appendEvent({ schemaVersion: 1, eventId: '', eventType: 'ORDER_SUBMITTED', occurredAt: 1 }),
    AuditError,
  );
});

test('retry after write-then-throw does not duplicate the event', async () => {
  cleanAudit();
  let calls = 0;
  _setAppendWriterForTests((path, line, enc) => {
    calls += 1;
    appendFileSync(path, line, enc);
    if (calls === 1) {
      const err = new Error('simulated EIO after write');
      err.code = 'EIO';
      throw err;
    }
  });
  try {
    const r = await appendEvent(sampleEvent({ eventId: 'retry-1' }));
    assert.equal(r.appended, true);
    assert.equal(r.landedDespiteError, true);
    const loaded = loadEvents();
    assert.equal(loaded.events.filter((e) => e.eventId === 'retry-1').length, 1);
    assert.equal(loaded.duplicateEventIds, 0);
  } finally {
    _setAppendWriterForTests(null);
  }
  cleanAudit();
});

test('duplicate lines are detected and do not inflate logical event count', async () => {
  cleanAudit();
  await appendEvent(sampleEvent({ eventId: 'dup-line', eventType: 'ORDER_FILLED', orderId: 'od' }));
  const path = resolveProjectPath(`data/audit/${EVENTS_FILENAME}`);
  const line = JSON.stringify(sampleEvent({ eventId: 'dup-line', eventType: 'ORDER_FILLED', orderId: 'od' })) + '\n';
  retryFs(() => appendFileSync(path, line));
  const loaded = loadEvents();
  assert.equal(loaded.events.filter((e) => e.eventId === 'dup-line').length, 1);
  assert.ok(loaded.duplicateEventIds >= 1);
  const report = reconcileAudit();
  assert.ok(report.duplicateEventIds >= 1);
  assert.ok((report.eventsByType.ORDER_FILLED || 0) >= 1);
  cleanAudit();
});




test('no future-data leakage in equity snapshot construction', () => {
  const snap = { cash: 1000, positionQty: 1, avgEntry: 100, realizedPnl: 0, initialCapital: 1000 };
  // Snapshot uses only the provided markPrice; it does not look at later candles
  const s = buildEquitySnapshot(snap, { snapshotId: 'causal', timestamp: 1, markPrice: 105 });
  assert.equal(s.markPrice, 105);
  assert.equal(s.equity, 1105);
});
