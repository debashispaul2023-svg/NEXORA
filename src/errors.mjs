/**
 * Shared error-handling utilities for FabInvests foundation.
 */

export class FabInvestsError extends Error {
  constructor(message, code = 'FABINVESTS_ERROR', details = null) {
    super(message);
    this.name = 'FabInvestsError';
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

export class PathError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'PATH_ERROR', details);
    this.name = 'PathError';
  }
}

export class MarketDataError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'MARKET_DATA_ERROR', details);
    this.name = 'MarketDataError';
  }
}

export class InitError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'INIT_ERROR', details);
    this.name = 'InitError';
  }
}

export class ExecutionError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'EXECUTION_ERROR', details);
    this.name = 'ExecutionError';
  }
}

export class AccountingError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'ACCOUNTING_ERROR', details);
    this.name = 'AccountingError';
  }
}

export class PersistenceError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'PERSISTENCE_ERROR', details);
    this.name = 'PersistenceError';
  }
}

export class RiskError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'RISK_ERROR', details);
    this.name = 'RiskError';
  }
}

export class AnalyticsError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'ANALYTICS_ERROR', details);
    this.name = 'AnalyticsError';
  }
}

export class AuditError extends FabInvestsError {
  constructor(message, details = null) {
    super(message, 'AUDIT_ERROR', details);
    this.name = 'AuditError';
  }
}






/**
 * Safe error serializer (never includes secrets or full stack in production logs).
 */
export function serializeError(err) {
  if (!(err instanceof Error)) {
    return { message: String(err), type: 'unknown' };
  }
  return {
    name: err.name,
    message: err.message,
    code: err.code || 'UNKNOWN',
    details: err.details || null,
  };
}
