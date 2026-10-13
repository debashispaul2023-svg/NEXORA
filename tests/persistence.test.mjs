import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { PaperExecutionEngine } from '../src/execution/engine.mjs';
import { AccountingLedger } from '../src/accounting/ledger.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';
import {
  saveSnapshot,
  loadSnapshot,
  SNAPSHOT_FILENAME,
  SNAPSHOT_BAK,
  SNAPSHOT_TMP,
  assertSafeDataPath,
} from '../src/persistence/store.mjs';
import { resolveProjectPath } from '../src/paths.mjs';
import { PersistenceError } from '../src/errors.mjs';

const candles = generateSyntheticSeries({ count: 5, startPrice: 100 });

function cleanSnapshots() {
  for (const name of [SNAPSHOT_FILENAME, SNAPSHOT_BAK, SNAPSHOT_TMP]) {
    const p = resolveProjectPath(`data/trades/${name}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

test('save and load round-trip restores cash, position, orders, ledger', () => {
  cleanSnapshots();
  const engine = new PaperExecutionEngine({ slippageBps: 0 });
  const ledger = new AccountingLedger({ initialCapital: 1000, feeBps: 0 });

  const buy = engine.submit({ id: 'p1', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);

  const path = saveSnapshot(engine, ledger);
  assert.ok(existsSync(path));

  const recovered = loadSnapshot();
  assert.ok(recovered);
  assert.equal(recovered.source, 'current');
  assert.equal(recovered.ledger.snapshot().cash, ledger.snapshot().cash);
  assert.equal(recovered.ledger.snapshot().positionQty, ledger.snapshot().positionQty);
  assert.equal(recovered.ledger.getLedger().length, 1);
  assert.ok(recovered.engine.getOrder('p1'));
  assert.equal(recovered.engine.getOrder('p1').order.state, 'filled');

  cleanSnapshots();
});

test('duplicate order prevented after recovery', () => {
  cleanSnapshots();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const buy = engine.submit({ id: 'idem-rec', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);
  saveSnapshot(engine, ledger);

  const rec = loadSnapshot();
  // Re-submit same id on recovered engine
  const again = rec.engine.submit({ id: 'idem-rec', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  assert.equal(again.order.state, 'filled');
  // Accounting remains idempotent
  const before = rec.ledger.snapshot();
  rec.ledger.applyFill(again);
  assert.deepEqual(rec.ledger.snapshot(), before);

  cleanSnapshots();
});

test('missing snapshot returns null', () => {
  cleanSnapshots();
  const rec = loadSnapshot();
  assert.equal(rec, null);
});

test('corrupt JSON falls back to backup when available', () => {
  cleanSnapshots();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const buy = engine.submit({ id: 'bak', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);
  saveSnapshot(engine, ledger); // creates current

  // Corrupt current
  const current = resolveProjectPath(`data/trades/${SNAPSHOT_FILENAME}`);
  writeFileSync(current, '{ not json');

  // Ensure bak exists (save rotates)
  // After first save there is no bak yet; do a second save to create bak, then corrupt current
  cleanSnapshots();
  saveSnapshot(engine, ledger);
  // Second save creates bak from first
  const engine2 = new PaperExecutionEngine();
  const ledger2 = new AccountingLedger({ initialCapital: 1000 });
  // Just re-save same state to force rotation
  saveSnapshot(engine, ledger);

  writeFileSync(resolveProjectPath(`data/trades/${SNAPSHOT_FILENAME}`), 'corrupt');

  const rec = loadSnapshot();
  assert.ok(rec);
  assert.equal(rec.source, 'backup');
  assert.equal(rec.ledger.snapshot().positionQty, 1);

  cleanSnapshots();
});

test('unsupported snapshot version is rejected', () => {
  cleanSnapshots();
  const bad = {
    version: 999,
    accounting: { cashCents: 100000, positionQty: 0, initialCapitalCents: 100000, feeBps: 0, ledger: [], processedFills: [] },
    execution: { slippageBps: 0, orders: {} },
  };
  writeFileSync(resolveProjectPath(`data/trades/${SNAPSHOT_FILENAME}`), JSON.stringify(bad));
  const rec = loadSnapshot();
  assert.equal(rec, null); // rejected, no fallback
  cleanSnapshots();
});

test('incomplete temporary file does not become current', () => {
  cleanSnapshots();
  const tmp = resolveProjectPath(`data/trades/${SNAPSHOT_TMP}`);
  writeFileSync(tmp, '{"incomplete": true');
  // load should ignore tmp and return null
  const rec = loadSnapshot();
  assert.equal(rec, null);
  // cleanup
  if (existsSync(tmp)) unlinkSync(tmp);
  cleanSnapshots();
});

test('unsafe path is rejected by resolveProjectPath', () => {
  assert.throws(() => assertSafeDataPath('../outside'), /traversal|escapes/);
  assert.throws(() => assertSafeDataPath('/tmp/evil'), /absolute/);
});

test('repeated saves are deterministic and keep last valid', () => {
  cleanSnapshots();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000 });
  const buy = engine.submit({ id: 'rep', type: 'MARKET', side: 'BUY', quantity: 1, timestamp: candles[0].timestamp }, candles);
  ledger.applyFill(buy);
  saveSnapshot(engine, ledger);
  const cash1 = ledger.snapshot().cash;
  saveSnapshot(engine, ledger);
  const rec = loadSnapshot();
  assert.equal(rec.ledger.snapshot().cash, cash1);
  cleanSnapshots();
});

test('recovery is deterministic across loads', () => {
  cleanSnapshots();
  const engine = new PaperExecutionEngine();
  const ledger = new AccountingLedger({ initialCapital: 1000, feeBps: 1 });
  const buy = engine.submit({ id: 'det', type: 'MARKET', side: 'BUY', quantity: 0.5, timestamp: candles[1].timestamp }, candles);
  ledger.applyFill(buy);
  saveSnapshot(engine, ledger, { trainingCheckpoint: { version: 1, note: 'reserved' } });

  const a = loadSnapshot();
  const b = loadSnapshot();
  assert.deepEqual(a.ledger.snapshot(), b.ledger.snapshot());
  assert.equal(a.snapshot.trainingCheckpoint.note, 'reserved');
  cleanSnapshots();
});
