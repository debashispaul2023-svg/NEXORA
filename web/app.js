const content = document.getElementById('content');
const pageTitle = document.getElementById('pageTitle');
const pageSub = document.getElementById('pageSub');
const nav = document.getElementById('nav');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const overlay = document.getElementById('overlay');
const pageFilter = document.getElementById('pageFilter');
const connection = document.getElementById('connection');

const TITLES = {
  overview: ['Overview', 'Stored paper and research records'],
  market: ['Market Data', 'Provider status and cache freshness'],
  experiments: ['Experiments', 'Registry and evaluation evidence'],
  ai: ['AI Learning', 'Provider, hypotheses, memory'],
  proposals: ['Proposals', 'Deterministic validation only'],
  paper: ['Risk & Paper', 'Simulated account and audit'],
  loop: ['Learning Loop', 'Derived from stored records'],
};

const FILE_PROTOCOL = location.protocol === 'file:' || location.protocol === 'content:';

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
overlay.addEventListener('click', () => setMenu(false));
nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
pageFilter.addEventListener('input', () => render());

function pageFromHash() {
  const hash = location.hash.replace('#', '') || 'overview';
  return TITLES[hash] ? hash : 'overview';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;',
  }[c]));
}
function show(value) {
  if (value == null || value === '') return 'Unavailable';
  return value;
}
function badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; }
function metric(label, value, hint = '', tone = '') {
  return `<article class="metric-card ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(show(value))}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</article>`;
}
function card(title, body) { return `<article class="card"><h2>${esc(title)}</h2>${body}</article>`; }
function empty(text) { return `<div class="empty">${esc(text)}</div>`; }
function errorBox(text) { return `<div class="error-box">${esc(text)}</div>`; }
function matches(text) {
  const q = pageFilter.value.trim().toLowerCase();
  return !q || String(text || '').toLowerCase().includes(q);
}
function toneForNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}
function bars(entries) {
  const items = Object.entries(entries || {});
  if (!items.length) return empty('No status breakdown. Empty registry is a valid state.');
  const max = Math.max(...items.map(([, n]) => Number(n) || 0), 1);
  return `<div class="bars">${items.map(([name, n]) => {
    const width = Math.round(((Number(n) || 0) / max) * 100);
    return `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div><strong>${esc(n)}</strong></div>`;
  }).join('')}</div>`;
}

async function api(path, opts) {
  if (FILE_PROTOCOL) {
    throw new Error('This page was opened as a local file. Start the server with node src/index.mjs --dashboard and open http://127.0.0.1:3002');
  }
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
  if (!res.ok && body.ok !== false) body.ok = false;
  return body;
}

function showConnection(message) {
  connection.hidden = !message;
  connection.textContent = message || '';
}

async function render() {
  const page = pageFromHash();
  const [title, sub] = TITLES[page];
  pageTitle.textContent = title;
  pageSub.textContent = sub;
  for (const link of nav.querySelectorAll('a')) link.classList.toggle('active', link.dataset.page === page);
  content.innerHTML = '<div class="skeleton-grid" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  try {
    if (FILE_PROTOCOL) {
      showConnection('Opened outside the dashboard server (file or content URL). No API is available here. Run node src/index.mjs --dashboard and open http://127.0.0.1:3002 on the same machine.');
      content.innerHTML = errorBox('Backend not reachable from a local file. The dashboard must be served by the NEXORA server.');
      return;
    }
    const health = await api('/api/health');
    if (!health.ok) throw new Error(health.error || 'Health check failed');
    showConnection('');
    if (page === 'overview') await renderOverview();
    else if (page === 'market') await renderMarket();
    else if (page === 'experiments') await renderExperiments();
    else if (page === 'ai') await renderAi();
    else if (page === 'proposals') await renderProposals();
    else if (page === 'paper') await renderPaper();
    else if (page === 'loop') await renderLoop();
  } catch (err) {
    showConnection(err.message);
    content.innerHTML = errorBox(`Failed to load page: ${err.message}`);
  }
}

async function renderOverview() {
  const data = await api('/api/overview');
  const exp = data.experiments || {};
  const ai = data.ai || {};
  const paper = data.paper || {};
  content.innerHTML = `
    <div class="grid">
      ${metric('Experiments', exp.total, exp.error ? 'Registry unavailable' : 'Stored records', 'light')}
      ${metric('AI provider', ai.provider?.label || 'Unavailable', ai.provider?.mock ? 'Mock — not an external LLM' : '', 'light')}
      ${metric('Paper status', paper.status, 'Simulated. Not a profit.', 'light')}
    </div>
    <div class="layout">
      <div class="stack">
        <article class="hero chart-panel">
          <h2>Research posture</h2>
          <p>${badge('PAPER MODE', 'ok')} ${badge('live trading disabled', 'ok')}</p>
          <p class="muted">Mode ${esc(show(data.config?.mode))} · Virtual capital ${esc(show(data.config?.initialVirtualCapital))} ${esc(data.config?.currency || '')}</p>
          <p class="muted">No equity curve is drawn unless a real series is returned. Current snapshot does not include a historical series.</p>
          ${exp.error ? errorBox(exp.error) : bars(exp.byStatus)}
        </article>
        ${card('Audit', data.audit?.error ? errorBox(data.audit.error) : `<p class="muted">Events: ${esc(show(data.audit?.stats?.total))} · Recent: ${esc(show(data.audit?.recentCount))}</p>`)}
      </div>
      <aside class="stack">
        <article class="hero">
          <h2>Paper snapshot</h2>
          <p class="muted">${esc(show(paper.message || paper.note))}</p>
          <p>Cash: ${esc(show(paper.cash))}</p>
          <p>Position: ${esc(show(paper.positionQty))}</p>
          <p>Equity: ${esc(show(paper.equity))}</p>
        </article>
        ${card('Market', `<p class="muted">Caches: ${esc(show(data.market?.cacheCount))}</p><p class="muted">Alpha Vantage configured: ${esc(show(data.market?.alphavantageConfigured))}</p>`)}
      </aside>
    </div>
  `;
}

async function renderMarket() {
  const data = await api('/api/market');
  const av = data.alphavantage || {};
  const rows = (data.caches || []).filter((c) => matches(`${c.provider} ${c.symbol}`)).map((c) => `
    <tr><td>${esc(c.provider)}</td><td>${esc(c.symbol)}</td><td>${esc(show(c.candleCount))}</td>
    <td>${c.fresh === true ? badge('fresh', 'ok') : badge(c.fresh === false ? 'stale' : 'unknown', 'mock')}</td>
    <td>${c.retrievedAt ? esc(new Date(c.retrievedAt).toISOString()) : 'Unavailable'}</td>
    <td>${c.quality ? esc(`ok=${c.quality.ok} e=${c.quality.errorCount} w=${c.quality.warningCount}`) : 'Unavailable'}</td></tr>`).join('');
  content.innerHTML = `
    <div class="grid">
      ${metric('Default', data.defaultProvider, 'Offline synthetic', 'light')}
      ${metric('Alpha Vantage', av.keyConfigured ? 'Configured' : 'Not configured', 'Daily, not real-time', 'light')}
      ${metric('Auto fetch', 'Off', 'No fetch on open', 'light')}
    </div>
    ${card('Provider notes', `<p class="muted">${esc(av.note || 'Unavailable')}</p><p class="note">${esc(data.note || '')}</p>`)}
    ${card('Cached datasets', rows
      ? `<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Symbol</th><th>Candles</th><th>Freshness</th><th>Retrieved</th><th>Quality</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty('No cached market data. External data is not fetched when this page opens.'))}
  `;
}

async function renderExperiments() {
  const data = await api('/api/experiments');
  if (!data.ok) { content.innerHTML = errorBox(data.error || 'Experiments unavailable'); return; }
  const experiments = (data.experiments || []).filter((e) => matches(`${e.id} ${e.strategyId} ${e.status}`));
  const rows = experiments.map((e) => `<tr>
    <td><a href="#experiments" data-exp="${esc(e.id)}">${esc(e.id)}</a></td>
    <td>${badge(e.status, e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : '')}</td>
    <td>${esc(e.strategyId)} ${esc(e.strategyVersion)}</td>
    <td>${esc(show(e.evaluationMethod))}</td>
    <td>${esc(show(e.dataSource))}</td>
    <td>${esc(show(e.sampleStatus))}</td>
    <td>${e.datasetReportSummary ? esc(`ok=${e.datasetReportSummary.ok}`) : 'Unavailable'}</td>
  </tr>`).join('');
  content.innerHTML = `
    <div class="filters"><select id="expStatus" aria-label="Filter by status"><option value="">All statuses</option>${[...new Set((data.experiments || []).map((e) => e.status))].map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
    <div id="expTable">${rows
      ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Strategy</th><th>Method</th><th>Source</th><th>Sample</th><th>Dataset</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty('No experiments match. An empty registry is a valid state.')}</div>
  `;
  const statusEl = document.getElementById('expStatus');
  if (statusEl) statusEl.addEventListener('change', () => {
    const status = statusEl.value;
    const filtered = (data.experiments || []).filter((e) => (!status || e.status === status) && matches(`${e.id} ${e.strategyId}`));
    document.getElementById('expTable').innerHTML = filtered.length
      ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Strategy</th><th>Method</th><th>Source</th><th>Sample</th><th>Dataset</th></tr></thead><tbody>${filtered.map((e) => `<tr><td><a href="#experiments" data-exp="${esc(e.id)}">${esc(e.id)}</a></td><td>${esc(e.status)}</td><td>${esc(e.strategyId)}</td><td>${esc(show(e.evaluationMethod))}</td><td>${esc(show(e.dataSource))}</td><td>${esc(show(e.sampleStatus))}</td><td>${e.datasetReportSummary ? esc(`ok=${e.datasetReportSummary.ok}`) : 'Unavailable'}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No experiments match.');
    bindExp();
  });
  bindExp();
}
function bindExp() {
  document.querySelectorAll('[data-exp]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const detail = await api(`/api/experiments/${el.dataset.exp}`);
      content.innerHTML = detail.ok ? experimentDetail(detail.experiment) : errorBox(detail.error);
    });
  });
}
function experimentDetail(exp) {
  return `<article class="hero"><h2>Experiment ${esc(exp.id)}</h2><p>${badge(exp.status || 'unknown')} ${badge(exp.dataSource || 'unknown')}</p><p class="muted">Missing fields stay Unavailable. In-sample is not out-of-sample.</p></article>
  <article class="card"><dl class="kv">
    <dt>Strategy</dt><dd>${esc(show(exp.strategyId))} ${esc(exp.strategyVersion || '')}</dd>
    <dt>Method</dt><dd>${esc(show(exp.evaluationMethod))}</dd>
    <dt>Fingerprint</dt><dd>${esc(show(exp.configFingerprint))}</dd>
    <dt>Sample</dt><dd>${esc(show(exp.sampleStatus))}</dd>
    <dt>Error</dt><dd>${esc(show(exp.error))}</dd>
  </dl></article>
  ${card('Metrics', exp.metrics ? `<pre>${esc(JSON.stringify(exp.metrics, null, 2))}</pre>` : empty('No metrics recorded.'))}`;
}

async function renderAi() {
  const status = await api('/api/ai');
  const hyps = await api('/api/hypotheses');
  const provider = status.provider || {};
  const rows = (hyps.hypotheses || []).filter((h) => matches(`${h.id} ${h.researchQuestion}`)).map((h) => `
    <tr><td>${esc(h.id)}</td><td>${esc(show(h.experimentId))}</td><td>${h.mock ? badge('mock', 'mock') : badge(h.provider || 'unknown')}</td><td>${esc(show(h.researchQuestion))}</td><td>${esc(show(h.uncertainty))}</td></tr>`).join('');
  content.innerHTML = `
    <article class="hero"><h2>${esc(provider.label || 'Unavailable')}</h2>
      <p>${provider.mock ? badge('mock provider — not an external LLM', 'mock') : badge(provider.available ? 'available' : 'unavailable', provider.available ? 'ok' : 'bad')}</p>
      <p class="muted">Available: ${esc(show(provider.available))} · Paid: ${esc(provider.paid ?? false)} · Live trading: disabled</p>
      ${provider.reason ? `<p class="warn">${esc(provider.reason)}</p>` : ''}</article>
    <div class="grid">${metric('Hypotheses', status.hypothesisCount, '', 'light')}${metric('Proposals', status.proposalCount, '', 'light')}${metric('Memory notes', status.memoryCount, 'Not model training', 'light')}</div>
    ${card('Hypotheses', !hyps.ok ? errorBox(hyps.error) : (rows ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Experiment</th><th>Provider</th><th>Question</th><th>Uncertainty</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No hypotheses. An unavailable provider does not invent output.')))}
  `;
}

async function renderProposals() {
  const data = await api('/api/proposals');
  if (!data.ok) { content.innerHTML = errorBox(data.error || 'Proposals unavailable'); return; }
  const rows = (data.proposals || []).filter((p) => matches(`${p.id} ${p.status}`)).map((p) => `
    <tr><td>${esc(p.id)}</td><td>${badge(p.status, p.status === 'validated' ? 'ok' : p.status === 'rejected' ? 'bad' : 'mock')}</td>
    <td>${esc(show(p.hypothesisId))}</td><td>${esc((p.experimentIds || []).join(', ') || 'none')}</td>
    <td>${esc((p.validationReasons || []).join(', ') || '—')}</td>
    <td><button class="btn secondary" data-validate="${esc(p.id)}">Validate</button></td></tr>`).join('');
  content.innerHTML = `${card('Proposal queue', `<p class="muted">Validation is deterministic. It does not execute trades or bypass risk rules.</p>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Hypothesis</th><th>Experiments</th><th>Reasons</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : empty('No proposals.')}
    <div id="validateResult"></div>`)}`;
  document.querySelectorAll('[data-validate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const result = await api(`/api/proposals/${btn.dataset.validate}/validate`, { method: 'POST' });
      document.getElementById('validateResult').innerHTML = result.ok
        ? `<p class="ok">Status: ${esc(result.proposal.status)}. Live trading: ${esc(result.liveTradingEnabled)}</p>`
        : errorBox(result.error);
      btn.disabled = false;
    });
  });
}

async function renderPaper() {
  const data = await api('/api/paper');
  const audit = await api('/api/audit');
  content.innerHTML = `
    <article class="hero"><h2>Simulated paper account</h2><p>${badge('PAPER MODE', 'ok')} ${badge('live trading disabled', 'ok')}</p>
      <p>Status: <strong>${esc(show(data.status))}</strong></p>
      ${data.error ? errorBox(data.error) : ''}${data.message ? `<p class="muted">${esc(data.message)}</p>` : ''}</article>
    <div class="grid">
      ${metric('Cash', data.cash, data.currency || 'virtual', 'light')}
      ${metric('Position', data.positionQty, '', 'light')}
      ${metric('Equity', data.equity, '', `light ${toneForNumber(data.equity)}`)}
      ${metric('Realized P&L', data.realizedPnl, 'Not a financial profit', `light ${toneForNumber(data.realizedPnl)}`)}
    </div>
    <p class="note">${esc(data.note || 'All execution is simulated. No exchange orders.')}</p>
    ${card('Recent audit events', !audit.ok ? errorBox(audit.error) : ((audit.recent || []).length
      ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Time</th><th>Order</th><th>Outcome</th></tr></thead><tbody>${audit.recent.map((e) => `<tr><td>${esc(show(e.type))}</td><td>${esc(show(e.timestamp))}</td><td>${esc(show(e.orderId))}</td><td>${esc(show(e.outcome))}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No audit events.')))}
  `;
}

async function renderLoop() {
  const data = await api('/api/loop');
  content.innerHTML = `${card('Lifecycle', `<p class="note">${esc(data.note || '')}</p><div class="stages">${(data.stages || []).map((s) => `
    <div class="stage ${s.ready ? 'ready' : ''}"><strong>${esc(s.label)}</strong><div class="muted">count: ${esc(show(s.count))}</div>
    <div>${s.ready ? badge('ready', 'ok') : badge('blocked', 'mock')}</div>${s.blocking ? `<p class="muted">${esc(s.blocking)}</p>` : ''}</div>`).join('')}</div>`)}
    <p class="note">Automatic improvement is not implemented. This page cannot promote a strategy or enable live trading.</p>`;
}

window.addEventListener('hashchange', render);
render();
