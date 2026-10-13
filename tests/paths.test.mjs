import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectRoot, resolveProjectPath } from '../src/paths.mjs';
import { existsSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('getProjectRoot finds AGENTS.md', () => {
  const root = getProjectRoot();
  assert.ok(existsSync(root + '/AGENTS.md'));
  assert.ok(existsSync(root + '/PROJECT_MAP.md'));
  assert.ok(root.includes('NEXORA_FabInvests_Starter'));
});

test('resolveProjectPath accepts relative paths inside root', () => {
  const p = resolveProjectPath('data/market');
  assert.ok(p.includes('data'));
  assert.ok(p.includes('market'));
});

test('resolveProjectPath accepts non-existent targets under root', () => {
  const p = resolveProjectPath('data/market/future-candle.json');
  assert.ok(p.includes('data'));
  assert.ok(p.includes('market'));
  assert.ok(p.endsWith('future-candle.json'));
  // Should not have escaped
  assert.ok(!p.includes('..'));
});

test('resolveProjectPath rejects absolute paths', () => {
  assert.throws(() => resolveProjectPath('/tmp/evil'), /absolute paths are not allowed/);
});

test('resolveProjectPath rejects parent traversal', () => {
  assert.throws(() => resolveProjectPath('../outside'), /parent-directory traversal/);
  assert.throws(() => resolveProjectPath('data/../../etc'), /parent-directory traversal/);
});

test('resolveProjectPath rejects symlink that escapes root', () => {
  const root = getProjectRoot();
  const linkName = join(root, 'tmp-escape-link');
  let created = false;
  try {
    // Point at a location outside the project
    symlinkSync('/tmp', linkName);
    created = true;
    assert.throws(
      () => resolveProjectPath('tmp-escape-link/something'),
      /escapes project root/
    );
  } catch (err) {
    // If symlink creation is not permitted in this environment, skip gracefully
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      console.log('symlink test skipped: permission denied');
      return;
    }
    throw err;
  } finally {
    if (created && existsSync(linkName)) {
      try { unlinkSync(linkName); } catch { /* ignore */ }
    }
  }
});
