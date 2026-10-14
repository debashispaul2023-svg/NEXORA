/**
 * Local-only NEXORA dashboard server.
 * Node.js built-in http. No external dependencies.
 * Binds to 127.0.0.1 by default. Not safe for public internet exposure.
 * Never returns secrets. Never enables live trading.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { getProjectRoot } from '../paths.mjs';
import { logger } from '../logger.mjs';
import {
  getOverview,
  getMarketStatus,
  getExperimentList,
  getExperimentDetail,
  getAiStatus,
  getHypothesisList,
  getHypothesisDetail,
  getProposalList,
  getProposalDetail,
  runProposalValidation,
  getPaperStatus,
  getAuditSummary,
  getLearningLoop,
  getSafeConfigSummary,
} from './adapters.mjs';

const MAX_BODY = 1024;

const STATIC = {
  '/': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'web/app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'web/styles.css', type: 'text/css; charset=utf-8' },
  '/branding/nexora-bot.png': { file: 'assets/branding/nexora-bot.png', type: 'image/png' },
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  res.end(payload);
}

function serveStatic(res, relFile, type) {
  const root = getProjectRoot();
  const absolute = resolve(root, relFile);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || rel.includes('..')) {
    json(res, 400, { ok: false, error: 'Invalid path' });
    return;
  }
  if (!existsSync(absolute)) {
    json(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  const data = readFileSync(absolute);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function route(method, url) {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/api/health') return { handler: () => ({ ok: true, service: 'nexora-dashboard', liveTradingEnabled: false, paperOnly: true }) };
  if (method === 'GET' && path === '/api/overview') return { handler: getOverview };
  if (method === 'GET' && path === '/api/market') return { handler: getMarketStatus };
  if (method === 'GET' && path === '/api/experiments') return { handler: getExperimentList };
  if (method === 'GET' && path === '/api/ai') return { handler: getAiStatus };
  if (method === 'GET' && path === '/api/hypotheses') return { handler: getHypothesisList };
  if (method === 'GET' && path === '/api/proposals') return { handler: getProposalList };
  if (method === 'GET' && path === '/api/paper') return { handler: getPaperStatus };
  if (method === 'GET' && path === '/api/audit') return { handler: () => getAuditSummary(30) };
  if (method === 'GET' && path === '/api/loop') return { handler: getLearningLoop };
  if (method === 'GET' && path === '/api/config') return { handler: getSafeConfigSummary };

  const exp = path.match(/^\/api\/experiments\/([A-Za-z0-9_-]{1,64})$/);
  if (method === 'GET' && exp) return { handler: () => getExperimentDetail(exp[1]) };
  const hyp = path.match(/^\/api\/hypotheses\/([A-Za-z0-9_-]{1,64})$/);
  if (method === 'GET' && hyp) return { handler: () => getHypothesisDetail(hyp[1]) };
  const prop = path.match(/^\/api\/proposals\/([A-Za-z0-9_-]{1,64})$/);
  if (method === 'GET' && prop) return { handler: () => getProposalDetail(prop[1]) };
  if (method === 'POST' && path.match(/^\/api\/proposals\/([A-Za-z0-9_-]{1,64})\/validate$/)) {
    const id = path.split('/')[3];
    return { handler: () => runProposalValidation(id) };
  }
  return null;
}

export function createDashboardServer() {
  const server = createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = req.url || '/';
      const path = url.split('?')[0];

      if (method === 'GET' && STATIC[path]) {
        serveStatic(res, STATIC[path].file, STATIC[path].type);
        return;
      }

      if (path.startsWith('/api/')) {
        if (method === 'POST') {
          try { await readBody(req); } catch (err) {
            json(res, 413, { ok: false, error: err.message });
            return;
          }
        }
        const matched = route(method, url);
        if (!matched) {
          json(res, 404, { ok: false, error: 'Unknown API route' });
          return;
        }
        const result = matched.handler();
        const status = result && result.ok === false && /not found|Invalid/i.test(result.error || '') ? 404 : 200;
        json(res, status, result);
        return;
      }

      json(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      logger.errorObj('Dashboard request failed', err);
      json(res, 500, { ok: false, error: 'Internal error' });
    }
  });
  return server;
}

/**
 * Start the dashboard bound to loopback only.
 * @param {{ port?: number, host?: string }} [opts]
 */
export function startDashboard(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port) || 3002;
  return new Promise((resolveStart, reject) => {
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      reject(new Error('Dashboard refuses non-loopback bind. Local-only. No authentication is implemented.'));
      return;
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      reject(new Error('dashboard port must be an integer between 1024 and 65535'));
      return;
    }
    const server = createDashboardServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = `http://${host}:${port}`;
      logger.info('NEXORA dashboard listening (local only, paper trading only)', {
        address,
        liveTradingEnabled: false,
        authenticated: false,
      });
      resolveStart({ server, url: address, port, host });
    });
  });
}
