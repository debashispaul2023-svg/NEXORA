import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { resolveProjectPath } from '../src/paths.mjs';
import { createDashboardServer } from '../src/dashboard/server.mjs';
import { createExperiment } from '../src/experiments/registry.mjs';
import { evaluateExperiment } from '../src/experiments/evaluate.mjs';
import { generateHypothesis } from '../src/ai/agent.mjs';
import { createProposal, listProposals } from '../src/ai/proposals.mjs';
import { generateSyntheticSeries } from '../src/market-data/fixtures.mjs';

function clean() {
  const dir = resolveProjectPath('data/experiments');
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function post(base, path) {
  const res = await fetch(`${base}${path}`, { method: 'POST' });
  const body = await res.json();
  return { status: res.status, body };
}

test('dashboard health, overview, and empty states', async () => {
  clean();
  const server = createDashboardServer();
  const base = await listen(server);
  try {
    const health = await get(base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.liveTradingEnabled, false);
    assert.equal(health.body.paperOnly, true);

    const overview = await get(base, '/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.config.mode, 'paper');
    assert.equal(overview.body.config.allowRealOrders, false);
    assert.equal(overview.body.liveTradingEnabled, false);
    assert.equal(overview.body.experiments.total, 0);

    const experiments = await get(base, '/api/experiments');
    assert.equal(experiments.body.ok, true);
    assert.equal(experiments.body.total, 0);

    const ai = await get(base, '/api/ai');
    assert.equal(ai.body.provider.mock, true);
    assert.match(ai.body.provider.label, /Mock/);
    assert.equal(ai.body.liveTradingEnabled, false);

    const market = await get(base, '/api/market');
    assert.equal(market.body.defaultProvider, 'synthetic');
    assert.equal(market.body.automaticFetch, false);
    assert.equal(typeof market.body.alphavantage.keyConfigured, 'boolean');
    assert.equal(JSON.stringify(market.body).includes('FABINVESTS_ALPHAVANTAGE_KEY='), false);
  } finally {
    server.close();
  }
});

test('dashboard rejects invalid ids and does not invent experiment metrics', async () => {
  clean();
  const server = createDashboardServer();
  const base = await listen(server);
  try {
    const bad = await get(base, '/api/experiments/../etc');
    assert.equal(bad.status, 404);

    const missing = await get(base, '/api/experiments/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);

    const exp = createExperiment({
      strategyId: 'baseline-sma-ema-rsi',
      strategyVersion: '1.0.0',
      dataSource: 'synthetic',
      config: { initialCapital: 1000 },
    });
    const list = await get(base, '/api/experiments');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.experiments[0].id, exp.id);
    assert.equal(list.body.experiments[0].metrics, null);
    assert.equal(list.body.experiments[0].dataSource, 'synthetic');

    const detail = await get(base, `/api/experiments/${exp.id}`);
    assert.equal(detail.body.ok, true);
    assert.equal(detail.body.experiment.strategyId, 'baseline-sma-ema-rsi');
    assert.equal(detail.body.experiment.metrics, null);
  } finally {
    server.close();
  }
});

test('dashboard proposal validation does not enable live trading', async () => {
  clean();
  const server = createDashboardServer();
  const base = await listen(server);
  try {
    const exp = createExperiment({
      strategyId: 'baseline-sma-ema-rsi',
      strategyVersion: '1.0.0',
      evaluationMethod: 'backtest',
      config: { initialCapital: 1000 },
      dataSource: 'synthetic',
    });
    await evaluateExperiment(exp.id, generateSyntheticSeries({ count: 30 }));
    const hyp = await generateHypothesis(exp.id);
    assert.equal(hyp.ok, true);
    const created = createProposal(hyp.hypothesis.id);
    assert.equal(created.proposal.liveTradingEnabled, false);

    const validated = await post(base, `/api/proposals/${created.proposal.id}/validate`);
    assert.equal(validated.body.ok, true);
    assert.equal(validated.body.proposal.status, 'validated');
    assert.equal(validated.body.proposal.liveTradingEnabled, false);
    assert.equal(validated.body.liveTradingEnabled, false);
    assert.equal(listProposals().length, 1);

    const missing = await post(base, '/api/proposals/not-a-real-id/validate');
    assert.equal(missing.body.ok, false);
    assert.match(missing.body.error, /not found|Invalid/i);
  } finally {
    server.close();
  }
});

test('dashboard static page loads and config hides secrets', async () => {
  const server = createDashboardServer();
  const base = await listen(server);
  try {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /NEXORA/);
    assert.match(html, /app\.js/);

    const config = await get(base, '/api/config');
    assert.equal(config.body.mode, 'paper');
    assert.equal(config.body.liveTradingEnabled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(config.body, 'apiKey'), false);
    const serialized = JSON.stringify(config.body);
    assert.equal(/sk-|api[_-]?key|secret|token|password/i.test(serialized), false);
  } finally {
    server.close();
  }
});

test('unavailable AI provider is labeled and does not invent hypotheses', async () => {
  clean();
  const prev = process.env.FABINVESTS_AI_PROVIDER;
  process.env.FABINVESTS_AI_PROVIDER = 'none';
  const server = createDashboardServer();
  const base = await listen(server);
  try {
    const ai = await get(base, '/api/ai');
    assert.equal(ai.body.provider.available, false);
    assert.equal(ai.body.provider.mock, false);
    assert.match(ai.body.provider.label, /Unavailable/);
    const hyps = await get(base, '/api/hypotheses');
    assert.equal(hyps.body.ok, true);
    assert.equal(hyps.body.hypotheses.length, 0);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FABINVESTS_AI_PROVIDER;
    else process.env.FABINVESTS_AI_PROVIDER = prev;
  }
});

test('dashboard refuses non-loopback bind', async () => {
  const { startDashboard } = await import('../src/dashboard/server.mjs');
  await assert.rejects(() => startDashboard({ host: '0.0.0.0', port: 3002 }), /loopback/);
});
