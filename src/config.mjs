import { readFileSync, existsSync } from 'node:fs';
import { resolveProjectPath } from './paths.mjs';
import { ConfigError } from './errors.mjs';
import { logger } from './logger.mjs';

/**
 * Centralized configuration management.
 * Loads .env (minimal built-in parser), merges with config.example.json defaults,
 * validates, and enforces paper-trading-only.
 */

const DEFAULT_CONFIG_PATH = 'config/config.example.json';

function loadDotEnv() {
  const envPath = resolveProjectPath('.env');
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip optional quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    logger.warn('Failed to load .env (continuing with process.env only)', { error: err.message });
  }
}

function loadDefaults() {
  const path = resolveProjectPath(DEFAULT_CONFIG_PATH);
  if (!existsSync(path)) {
    throw new ConfigError(`Default config not found: ${DEFAULT_CONFIG_PATH}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse default config: ${err.message}`);
  }
}

function validateConfig(cfg) {
  const errors = [];

  // Mode must be paper
  if (cfg.project?.mode !== 'paper') {
    errors.push('project.mode must be "paper"');
  }
  if (cfg.safety?.paperTradingOnly !== true) {
    errors.push('safety.paperTradingOnly must be true');
  }
  if (cfg.safety?.allowRealOrders !== false) {
    errors.push('safety.allowRealOrders must be false');
  }

  // Numeric ranges
  const loop = Number(cfg.runtime?.loopSeconds);
  if (!Number.isFinite(loop) || loop < 5 || loop > 3600) {
    errors.push('runtime.loopSeconds must be a number between 5 and 3600');
  }
  const port = Number(cfg.runtime?.dashboardPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errors.push('runtime.dashboardPort must be an integer between 1024 and 65535');
  }
  const capital = Number(cfg.capital?.initialVirtualCapital);
  if (!Number.isFinite(capital) || capital <= 0) {
    errors.push('capital.initialVirtualCapital must be a positive number');
  }

  if (errors.length) {
    throw new ConfigError('Configuration validation failed', { errors });
  }
  return cfg;
}

/**
 * Load, merge, and validate configuration.
 * @returns {object} Validated config.
 */
export function loadConfig() {
  loadDotEnv();

  const defaults = loadDefaults();

  // Environment overrides (prefix FABINVESTS_)
  const env = process.env;
  const overrides = {
    project: {
      mode: env.FABINVESTS_MODE || defaults.project.mode,
    },
    runtime: {
      loopSeconds: env.FABINVESTS_LOOP_SECONDS ? Number(env.FABINVESTS_LOOP_SECONDS) : defaults.runtime.loopSeconds,
      dashboardPort: env.FABINVESTS_DASHBOARD_PORT ? Number(env.FABINVESTS_DASHBOARD_PORT) : defaults.runtime.dashboardPort,
      timezone: env.FABINVESTS_TIMEZONE || defaults.runtime.timezone,
    },
    capital: {
      initialVirtualCapital: env.FABINVESTS_INITIAL_CAPITAL ? Number(env.FABINVESTS_INITIAL_CAPITAL) : defaults.capital.initialVirtualCapital,
      currency: env.FABINVESTS_CURRENCY || defaults.capital.currency,
    },
  };

  // Deep merge (shallow for this foundation)
  const merged = {
    ...defaults,
    project: { ...defaults.project, ...overrides.project },
    runtime: { ...defaults.runtime, ...overrides.runtime },
    capital: { ...defaults.capital, ...overrides.capital },
    safety: { ...defaults.safety }, // safety flags never overridden by env in Phase 1
  };

  // Log level
  if (env.FABINVESTS_LOG_LEVEL) {
    // Applied later by caller if desired
  }

  return validateConfig(merged);
}

export { validateConfig };
