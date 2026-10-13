import { serializeError } from './errors.mjs';

/**
 * Structured logger. Outputs JSON lines. Never logs secrets.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

export function setLogLevel(level) {
  if (LEVELS[level] === undefined) {
    throw new Error(`Invalid log level: ${level}`);
  }
  currentLevel = LEVELS[level];
}

function shouldLog(level) {
  return LEVELS[level] >= currentLevel;
}

function emit(level, message, meta = {}) {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  // Ensure no accidental secret leakage
  const safe = JSON.stringify(entry, (k, v) => {
    if (typeof k === 'string' && /secret|password|key|token|credential/i.test(k)) {
      return '[REDACTED]';
    }
    return v;
  });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(safe + '\n');
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  errorObj: (msg, err, meta = {}) => emit('error', msg, { ...meta, error: serializeError(err) }),
};
