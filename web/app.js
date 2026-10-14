const content = document.getElementById('content');
const pageTitle = document.getElementById('pageTitle');
const nav = document.getElementById('nav');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');

const TITLES = {
  overview: 'Overview',
  market: 'Market Data',
  experiments: 'Experiments',
  ai: 'AI Learning',
  proposals: 'Proposals',
  paper: 'Risk & Paper',
  loop: 'Learning Loop',
};

menuBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
nav.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') sidebar.classList.remove('open');
});

function pageFromHash() {
  const hash = location.hash.replace('#', '') || 'overview';
  return TITLES[hash] ? hash : 'overview';
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
  if (!res.ok && body.ok !== false) body.ok = false;
  return body;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;',
  }[c]));
}

function card(title, body) {
  return `<article class="card"><h2>${esc(title)}</h2>${body}</article>`;
}

function metric(label, value, extra = '') {
  return `<div class="card"><div class="muted">${esc(label)}</div><div class="metric">${esc(value)}</div>${extra}</div>`;
}

function badge(text, kind = '') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

async function render() {
  const page = pageFromHash();
  pageTitle.textContent = TITLES[page];
  for (const link of nav.querySelectorAll('a')) {
    link.classList.toggle('active', link.dataset.page === page);
  }
  content.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (page === 'overview') await renderOverview();
    else if (page === 'market') await renderMarket();
    else if (page === 'experiments') await renderExperiments();
    else if (page === 'ai') await renderAi();
    else if (page === 'proposals') await renderProposals();
    else if (page === 'paper') await renderPaper();
    else if (page === 'loop') await renderLoop();
  } catch (err) {
    content.innerHTML = `<div class="error-box">Failed to load page: ${esc(err.message)}</div>`;
  }
}

async function renderOverview() {
  const data = await api('/api/overview');
  const exp = data.experiments || {};
  const ai = data.ai || {};
  const paper = data.paper || {};
  content.innerHTML = `
    <div class="grid">
      ${metric('Experiments', exp.total ?? 'Unavailable')}
      ${metric('AI provider', ai.provider?.label || 'Unavailable', ai.provider?.mock ? badge('mock', 'mock') : '')}
      ${metric('Paper status', paper.status || 'Unavailable', badge('simulated', 'ok'))}
      ${metric('Market caches', data.market?.cacheCount ?? 'Unavailable')}
    </div>
    ${card('Safety', `
      <p>${badge('paper only', 'ok')} ${badge('live trading disabled', 'ok')}</p>
      <p class="muted">Mode: ${esc(data.config?.mode)} · Capital: ${esc(data.config?.initialVirtualCapital)} ${esc(data.config?.currency)}</p>
      <p class="muted">Real orders allowed: ${esc(data.config?.allowRealOrders)}</p>
    `)}
    ${card('Experiment status', exp.error
      ? `<div class="error-box">${esc(exp.error)}</div>`
      : `<p>${Object.entries(exp.byStatus || {}).map(([k, v]) => badge(`${k}: ${v}`)).join(' ') || 'No experiments'}</p>`)}
    ${card('Latest audit', data.audit?.error
      ? `<div class="error-box">${esc(data.audit.error)}</div>`
      : `<p class="muted">Events: ${esc(data.audit?.stats?.total ?? 'Unavailable')} · Recent shown: ${esc(data.audit?.recentCount ?? 0)}</p>`)}
  `;
}

async function renderMarket() {
  const data = await api('/api/market');
  const av = data.alphavantage || {};
  const rows = (data.caches || []).map((c) => `
    <tr>
      <td>${esc(c.provider)}</td>
      <td>${esc(c.symbol)}</td>
      <td>${esc(c.candleCount)}</td>
      <td>${c.fresh === true ? badge('fresh', 'ok') : badge(c.fresh === false ? 'stale' : 'unknown', 'mock')}</td>
      <td>${esc(c.quality ? `ok=${c.quality.ok} e=${c.quality.errorCount} w=${c.quality.warningCount}` : 'Unavailable')}</td>
    </tr>`).join('');
  content.innerHTML = `
    ${card('Provider', `
      <p>Default: <strong>${esc(data.defaultProvider)}</strong> ${badge('offline', 'ok')}</p>
      <p>Alpha Vantage: ${av.keyConfigured ? badge('key configured', 'ok') : badge('not configured', 'mock')}</p>
      <p class="muted">${esc(av.note)}</p>
      <p class="muted">Automatic fetch on open: ${esc(data.automaticFetch)}</p>
    `)}
    ${card('Cached datasets', rows
      ? `<table><thead><tr><th>Provider</th><th>Symbol</th><th>Candles</th><th>Freshness</th><th>Quality</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No cached market data. Dashboard does not fetch external data on open.</div>')}
    <p class="muted">${esc(data.note)}</p>
  `;
}

async function renderExperiments() {
  const data = await api('/api/experiments');
  if (!data.ok) {
    content.innerHTML = `<div class="error-box">${esc(data.error || 'Experiments unavailable')}</div>`;
    return;
  }
  const experiments = data.experiments || [];
  content.innerHTML = `
    <div class="filters">
      <input id="expSearch" placeholder="Search id or strategy" />
      <select id="expStatus"><option value="">All statuses</option>${[...new Set(experiments.map((e) => e.status))].map((s) => `<option>${esc(s)}</option>`).join('')}</select>
    </div>
    <div id="expTable"></div>
  `;
  const draw = () => {
    const q = document.getElementById('expSearch').value.toLowerCase();
    const status = document.getElementById('expStatus').value;
    const filtered = experiments.filter((e) => {
      const hay = `${e.id} ${e.strategyId} ${e.configFingerprint}`.toLowerCase();
      return (!q || hay.includes(q)) && (!status || e.status === status);
    });
    document.getElementById('expTable').innerHTML = filtered.length
      ? `<table><thead><tr><th>ID</th><th>Status</th><th>Strategy</th><th>Method</th><th>Source</th><th>Sample</th><th>Dataset</th></tr></thead><tbody>
        ${filtered.map((e) => `<tr>
          <td><a href="#experiments" data-exp="${esc(e.id)}">${esc(e.id)}</a></td>
          <td>${esc(e.status)}</td>
          <td>${esc(e.strategyId)} ${esc(e.strategyVersion)}</td>
          <td>${esc(e.evaluationMethod)}</td>
          <td>${esc(e.dataSource)}</td>
          <td>${esc(e.sampleStatus || 'Unavailable')}</td>
          <td>${e.datasetReportSummary ? esc(`ok=${e.datasetReportSummary.ok}`) : 'Unavailable'}</td>
        </tr>`).join('')}
      </tbody></table>`
      : '<div class="empty">No experiments match. Empty registry is a valid state.</div>';
    document.querySelectorAll('[data-exp]').forEach((el) => {
      el.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const detail = await api(`/api/experiments/${el.dataset.exp}`);
        content.innerHTML = detail.ok
          ? card('Experiment detail', `<pre>${esc(JSON.stringify(detail.experiment, null, 2))}</pre>`)
          : `<div class="error-box">${esc(detail.error)}</div>`;
      });
    });
  };
  document.getElementById('expSearch').addEventListener('input', draw);
  document.getElementById('expStatus').addEventListener('change', draw);
  draw();
}

async function renderAi() {
  const status = await api('/api/ai');
  const hyps = await api('/api/hypotheses');
  const provider = status.provider || {};
  const rows = (hyps.hypotheses || []).map((h) => `
    <tr>
      <td>${esc(h.id)}</td>
      <td>${esc(h.experimentId)}</td>
      <td>${h.mock ? badge('mock', 'mock') : badge(h.provider || 'unknown')}</td>
      <td>${esc(h.researchQuestion)}</td>
      <td>${esc(h.uncertainty || 'Unavailable')}</td>
    </tr>`).join('');
  content.innerHTML = `
    ${card('Provider', `
      <p>${esc(provider.label || 'Unavailable')} ${provider.mock ? badge('not an external LLM', 'mock') : ''}</p>
      <p class="muted">Available: ${esc(provider.available)} · Paid: ${esc(provider.paid ?? false)}</p>
      ${provider.reason ? `<p class="warn">${esc(provider.reason)}</p>` : ''}
    `)}
    ${card('Hypotheses', !hyps.ok
      ? `<div class="error-box">${esc(hyps.error)}</div>`
      : (rows ? `<table><thead><tr><th>ID</th><th>Experiment</th><th>Provider</th><th>Question</th><th>Uncertainty</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No hypotheses. Mock output is never fabricated when the provider is unavailable.</div>'))}
    ${card('Memory', `<p class="muted">Notes: ${esc(status.memoryCount ?? 'Unavailable')}</p>`)}
  `;
}

async function renderProposals() {
  const data = await api('/api/proposals');
  if (!data.ok) {
    content.innerHTML = `<div class="error-box">${esc(data.error || 'Proposals unavailable')}</div>`;
    return;
  }
  const rows = (data.proposals || []).map((p) => `
    <tr>
      <td>${esc(p.id)}</td>
      <td>${badge(p.status, p.status === 'validated' ? 'ok' : p.status === 'rejected' ? 'bad' : 'mock')}</td>
      <td>${esc(p.hypothesisId)}</td>
      <td>${esc((p.experimentIds || []).join(', ') || 'none')}</td>
      <td>${esc((p.validationReasons || []).join(', ') || '—')}</td>
      <td><button class="btn secondary" data-validate="${esc(p.id)}">Validate</button></td>
    </tr>`).join('');
  content.innerHTML = `
    ${card('Proposal queue', `
      <p class="muted">Validation is deterministic and does not execute trades or change strategy configuration.</p>
      ${rows ? `<table><thead><tr><th>ID</th><th>Status</th><th>Hypothesis</th><th>Experiments</th><th>Reasons</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No proposals.</div>'}
      <div id="validateResult"></div>
    `)}
  `;
  document.querySelectorAll('[data-validate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const result = await api(`/api/proposals/${btn.dataset.validate}/validate`, { method: 'POST' });
      document.getElementById('validateResult').innerHTML = result.ok
        ? `<p class="ok">Validated. Status: ${esc(result.proposal.status)}. Live trading: ${esc(result.liveTradingEnabled)}</p>`
        : `<div class="error-box">${esc(result.error)}</div>`;
      btn.disabled = false;
    });
  });
}

async function renderPaper() {
  const data = await api('/api/paper');
  const audit = await api('/api/audit');
  content.innerHTML = `
    ${card('Paper session', `
      <p>${badge('simulated', 'ok')} ${badge('live trading disabled', 'ok')}</p>
      <p>Status: <strong>${esc(data.status || 'Unavailable')}</strong></p>
      ${data.error ? `<div class="error-box">${esc(data.error)}</div>` : ''}
      ${data.message ? `<p class="muted">${esc(data.message)}</p>` : ''}
      <div class="grid">
        ${metric('Cash', data.cash ?? 'Unavailable')}
        ${metric('Position', data.positionQty ?? 'Unavailable')}
        ${metric('Equity', data.equity ?? 'Unavailable')}
        ${metric('Realized P&L', data.realizedPnl ?? 'Unavailable')}
      </div>
      <p class="muted">${esc(data.note || 'All execution is simulated. No exchange orders.')}</p>
    `)}
    ${card('Recent audit events', !audit.ok
      ? `<div class="error-box">${esc(audit.error)}</div>`
      : ((audit.recent || []).length
        ? `<table><thead><tr><th>Type</th><th>Time</th><th>Order</th><th>Outcome</th></tr></thead><tbody>
            ${audit.recent.map((e) => `<tr><td>${esc(e.type)}</td><td>${esc(e.timestamp)}</td><td>${esc(e.orderId)}</td><td>${esc(e.outcome)}</td></tr>`).join('')}
          </tbody></table>`
        : '<div class="empty">No audit events.</div>'))}
  `;
}

async function renderLoop() {
  const data = await api('/api/loop');
  content.innerHTML = `
    ${card('Lifecycle', `
      <p class="muted">${esc(data.note)}</p>
      <div class="stages">
        ${(data.stages || []).map((s) => `
          <div class="stage ${s.ready ? 'ready' : ''}">
            <strong>${esc(s.label)}</strong>
            <div class="muted">count: ${esc(s.count)}</div>
            <div>${s.ready ? badge('ready', 'ok') : badge('blocked', 'mock')}</div>
            ${s.blocking ? `<p class="muted">${esc(s.blocking)}</p>` : ''}
          </div>`).join('')}
      </div>
    `)}
    <p class="muted">Automatic improvement is not implemented. Promotion rules are not bypassed by this page.</p>
  `;
}

window.addEventListener('hashchange', render);
render();
