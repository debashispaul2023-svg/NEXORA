import { mkdirSync, existsSync } from 'node:fs';
import { getDataDir, resolveProjectPath } from './paths.mjs';
import { InitError } from './errors.mjs';
import { logger } from './logger.mjs';

/**
 * Idempotent data-directory initialization.
 * Creates approved subdirectories under data/ if they do not exist.
 * Never deletes or overwrites existing content.
 */

const DATA_SUBDIRS = [
  'market',
  'trades',
  'episodes',
  'strategies',
  'world',
];

export function initDataDirectories() {
  const dataDir = getDataDir();
  const created = [];

  try {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      created.push('data');
    }

    for (const sub of DATA_SUBDIRS) {
      const full = resolveProjectPath(`data/${sub}`);
      if (!existsSync(full)) {
        mkdirSync(full, { recursive: true });
        created.push(`data/${sub}`);
      }
    }

    if (created.length) {
      logger.info('Data directories initialized', { created });
    } else {
      logger.info('Data directories already present');
    }
    return { ok: true, created };
  } catch (err) {
    throw new InitError(`Failed to initialize data directories: ${err.message}`, { cause: err.message });
  }
}

/**
 * Basic health check.
 */
export function healthCheck(config) {
  const checks = [];

  // Config present
  checks.push({ name: 'config', ok: !!config, detail: config ? 'loaded' : 'missing' });

  // Data dirs
  try {
    const dataDir = getDataDir();
    checks.push({ name: 'data_dir', ok: existsSync(dataDir), detail: dataDir });
  } catch (err) {
    checks.push({ name: 'data_dir', ok: false, detail: err.message });
  }

  // Paper mode
  checks.push({
    name: 'paper_mode',
    ok: config?.project?.mode === 'paper' && config?.safety?.paperTradingOnly === true,
    detail: 'paper trading only',
  });

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks };
}
