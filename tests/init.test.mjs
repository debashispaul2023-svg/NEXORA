import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDataDirectories, healthCheck } from '../src/init.mjs';
import { loadConfig } from '../src/config.mjs';
import { existsSync } from 'node:fs';
import { getDataDir } from '../src/paths.mjs';

test('initDataDirectories is idempotent and creates expected subdirs', () => {
  const result1 = initDataDirectories();
  assert.equal(result1.ok, true);

  const dataDir = getDataDir();
  assert.ok(existsSync(dataDir));
  for (const sub of ['market', 'trades', 'episodes', 'strategies', 'world']) {
    assert.ok(existsSync(dataDir + '/' + sub), `missing ${sub}`);
  }

  // Second call should not recreate
  const result2 = initDataDirectories();
  assert.equal(result2.ok, true);
  assert.equal(result2.created.length, 0);
});

test('healthCheck passes with valid config', () => {
  const cfg = loadConfig();
  const health = healthCheck(cfg);
  assert.equal(health.ok, true);
  assert.ok(health.checks.every((c) => c.ok));
});
