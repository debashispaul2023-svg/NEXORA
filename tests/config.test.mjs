import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { ConfigError } from '../src/errors.mjs';

test('loadConfig returns valid paper-trading config by default', () => {
  const cfg = loadConfig();
  assert.equal(cfg.project.mode, 'paper');
  assert.equal(cfg.safety.paperTradingOnly, true);
  assert.equal(cfg.safety.allowRealOrders, false);
  assert.ok(cfg.runtime.loopSeconds >= 5);
  assert.ok(cfg.capital.initialVirtualCapital > 0);
});

test('validateConfig rejects non-paper mode', () => {
  const bad = {
    project: { mode: 'live' },
    safety: { paperTradingOnly: true, allowRealOrders: false },
    runtime: { loopSeconds: 30, dashboardPort: 3002 },
    capital: { initialVirtualCapital: 1000 },
  };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('validateConfig rejects invalid loopSeconds', () => {
  const bad = {
    project: { mode: 'paper' },
    safety: { paperTradingOnly: true, allowRealOrders: false },
    runtime: { loopSeconds: 1, dashboardPort: 3002 },
    capital: { initialVirtualCapital: 1000 },
  };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('validateConfig rejects negative capital', () => {
  const bad = {
    project: { mode: 'paper' },
    safety: { paperTradingOnly: true, allowRealOrders: false },
    runtime: { loopSeconds: 30, dashboardPort: 3002 },
    capital: { initialVirtualCapital: -100 },
  };
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('environment override of loopSeconds is accepted when valid', () => {
  const original = process.env.FABINVESTS_LOOP_SECONDS;
  try {
    process.env.FABINVESTS_LOOP_SECONDS = '60';
    const cfg = loadConfig();
    assert.equal(cfg.runtime.loopSeconds, 60);
    // Safety remains paper-only
    assert.equal(cfg.project.mode, 'paper');
    assert.equal(cfg.safety.paperTradingOnly, true);
    assert.equal(cfg.safety.allowRealOrders, false);
  } finally {
    if (original === undefined) delete process.env.FABINVESTS_LOOP_SECONDS;
    else process.env.FABINVESTS_LOOP_SECONDS = original;
  }
});

test('environment cannot force non-paper mode', () => {
  const original = process.env.FABINVESTS_MODE;
  try {
    process.env.FABINVESTS_MODE = 'live';
    assert.throws(() => loadConfig(), ConfigError);
  } finally {
    if (original === undefined) delete process.env.FABINVESTS_MODE;
    else process.env.FABINVESTS_MODE = original;
  }
});
