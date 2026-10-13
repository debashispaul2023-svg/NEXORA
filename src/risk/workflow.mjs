import { evaluateRisk, validateRiskConfig, DailyLossTracker } from './engine.mjs';
import { RiskError } from '../errors.mjs';
import { saveSnapshot, loadSnapshot } from '../persistence/store.mjs';
import { appendEvent, EVENT_SCHEMA_VERSION } from '../audit/events.mjs';
import { buildEquitySnapshot, appendEquitySnapshot } from '../audit/equity.mjs';
import { withProcessLock } from '../audit/lock.mjs';

/**
 * Public paper-trading workflow.
 * Enforces: validate → risk → (reject | execute → account → persist).
 *
 * Phase 9.1:
 * - submitOrder is serialized within this process (not multi-process safe).
 * - Rejection stages are explicit: risk, execution, accounting, rollback.
 * - TRANSACTION_ROLLED_BACK is used for post-accounting rollback.
 * - Audit write failures are reported as auditDegraded and do not roll back
 *   an already-committed financial transaction.
 * - Multi-file atomicity is not claimed.
 */

export class PaperTradingWorkflow {
  constructor({
    engine,
    ledger,
    riskLimits = {},
    dailyTracker = null,
    persist = true,
    persistFn = null,
    audit = true,
    appendEventFn = null,
    appendEquityFn = null,
    markPrice = null,
    strategyId = null,
    strategyVersion = null,
  } = {}) {
    if (!engine || !ledger) throw new RiskError('engine and ledger are required');
    this.engine = engine;
    this.ledger = ledger;
    this.limits = validateRiskConfig(riskLimits);
    this.daily = dailyTracker || new DailyLossTracker({
      timezone: this.limits.timezone,
      limit: this.limits.dailyRealizedLossLimit,
    });
    this.persist = persist;
    this.persistFn = persistFn || saveSnapshot;
    this.audit = audit;
    this.appendEventFn = appendEventFn || appendEvent;
    this.appendEquityFn = appendEquityFn || appendEquitySnapshot;
    this.markPrice = markPrice;
    this.strategyId = strategyId;
    this.strategyVersion = strategyVersion;
    this.auditFailures = [];
  }

  _emit(eventType, intent, extra = {}) {
    if (!this.audit) return Promise.resolve({ emitted: false });
    const correlationId = intent.id;
    const eventId = `${eventType}:${correlationId}:${extra.suffix || '1'}`;
    const payload = {
      stage: extra.stage || null,
      reasonCode: extra.reasonCode || null,
      outcome: extra.outcome || null,
      transactionStatus: extra.transactionStatus || null,
      ...(extra.payload || {}),
    };
    return this.appendEventFn({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      eventType,
      occurredAt: Number(intent.timestamp) || Date.now(),
      source: 'PaperTradingWorkflow',
      correlationId,
      orderId: intent.id,
      fillId: extra.fillId || null,
      strategyId: extra.strategyId || this.strategyId,
      strategyVersion: extra.strategyVersion || this.strategyVersion,
      candleTimestamp: Number(intent.timestamp) || null,
      payload,
    }).then(
      (result) => ({ emitted: true, duplicate: !!result?.duplicate }),
      (err) => {
        this.auditFailures.push({
          eventType,
          stage: extra.stage || null,
          error: err.message,
          orderId: intent.id,
          correlationId,
          classification: 'audit_write_failed',
        });
        return { emitted: false, error: err.message };
      },
    );
  }

  async _recordEquity(intent, modeNote) {
    if (!this.audit) return null;
    try {
      const snap = this.ledger.snapshot();
      const eq = buildEquitySnapshot(snap, {
        snapshotId: `eq:${intent.id}:${modeNote}`,
        timestamp: Number(intent.timestamp) || Date.now(),
        markPrice: this.markPrice,
        markSource: this.markPrice != null ? 'workflow' : null,
      });
      const result = await this.appendEquityFn(eq);
      await this._emit('EQUITY_SNAPSHOT_RECORDED', intent, {
        suffix: modeNote,
        stage: 'equity',
        outcome: modeNote,
        payload: { snapshotId: eq.snapshotId, mode: eq.mode },
      });
      return result;
    } catch (err) {
      this.auditFailures.push({
        eventType: 'EQUITY_SNAPSHOT',
        stage: 'equity',
        error: err.message,
        orderId: intent.id,
        classification: 'audit_write_failed',
      });
      await this._emit('AUDIT_FAILURE', intent, {
        suffix: 'equity',
        stage: 'equity',
        reasonCode: 'equity_write_failed',
        outcome: 'committed_audit_degraded',
        transactionStatus: 'committed',
        payload: { message: err.message },
      });
      return { error: err.message };
    }
  }

  async submitOrder(intent, candles) {
    return withProcessLock(() => this._submitOrderUnlocked(intent, candles));
  }

  async _submitOrderUnlocked(intent, candles) {
    this.auditFailures = [];
    const correlationId = intent.id;

    await this._emit('ORDER_SUBMITTED', intent, {
      stage: 'submit',
      outcome: 'submitted',
      payload: { side: intent.side, quantity: intent.quantity },
    });

    let estimatedPrice = null;
    try {
      const series = candles || [];
      const ts = Number(intent.timestamp);
      const candle = series.find((c) => c.timestamp >= ts);
      if (candle) {
        const slip = (this.engine.slippageBps || 0) / 10000;
        const raw = candle.close;
        estimatedPrice = intent.side === 'SELL' ? raw * (1 - slip) : raw * (1 + slip);
      }
    } catch {
      estimatedPrice = null;
    }

    const snap = this.ledger.snapshot();
    let riskResult;
    try {
      riskResult = evaluateRisk(
        { ...intent, quantity: Number(intent.quantity), timestamp: Number(intent.timestamp) },
        snap,
        estimatedPrice,
        this.limits,
        this.daily,
      );
    } catch (err) {
      await this._emit('ORDER_REJECTED', intent, {
        stage: 'risk',
        reasonCode: 'risk_evaluation_failed',
        outcome: 'risk_failed',
        transactionStatus: 'not_executed',
        payload: { message: err.message },
      });
      return this._result(false, 'risk_failed', correlationId, { risk: { approved: false, reasons: [{ code: 'risk_evaluation_failed', message: err.message }] } });
    }

    if (!riskResult.approved) {
      await this._emit('ORDER_REJECTED', intent, {
        stage: 'risk',
        reasonCode: riskResult.reasons[0]?.code || 'risk_rejected',
        outcome: 'risk_rejected',
        transactionStatus: 'not_executed',
        payload: { reasons: riskResult.reasons },
      });
      return this._result(false, 'risk_rejected', correlationId, { risk: riskResult });
    }

    await this._emit('ORDER_APPROVED', intent, {
      stage: 'risk',
      outcome: 'approved',
      transactionStatus: 'approved_not_filled',
    });

    const preLedger = this.ledger.exportState();
    const preDaily = this.daily.exportState();
    const preEngine = this.engine.exportState();

    const execResult = this.engine.submit(intent, candles);
    if (execResult.order.state !== 'filled') {
      await this._emit('ORDER_REJECTED', intent, {
        suffix: 'exec',
        stage: 'execution',
        reasonCode: 'execution_rejected',
        outcome: 'execution_rejected',
        transactionStatus: 'not_filled',
        payload: { detail: execResult.order.rejectReason },
      });
      return this._result(false, 'execution_rejected', correlationId, { result: execResult, risk: riskResult });
    }

    await this._emit('ORDER_FILLED', intent, {
      fillId: `${intent.id}-fill`,
      stage: 'execution',
      outcome: 'filled',
      transactionStatus: 'filled_not_accounted',
      payload: { price: execResult.fill.price, quantity: execResult.fill.quantity },
    });

    const before = this.ledger.snapshot();
    try {
      this.ledger.applyFill(execResult);
    } catch (err) {
      this.engine.importState(preEngine);
      await this._emit('ORDER_REJECTED', intent, {
        suffix: 'acct',
        stage: 'accounting',
        reasonCode: 'accounting_rejected',
        outcome: 'accounting_rejected',
        transactionStatus: 'not_applied',
        payload: { message: err.message },
      });
      return this._result(false, 'accounting_rejected', correlationId, {
        result: execResult,
        risk: riskResult,
        accountingError: err.message,
      });
    }

    await this._emit('ACCOUNTING_APPLIED', intent, {
      stage: 'accounting',
      outcome: 'applied',
      transactionStatus: 'applied_pending_persist',
      payload: { cash: this.ledger.snapshot().cash, positionQty: this.ledger.snapshot().positionQty },
    });

    if (intent.side === 'SELL') {
      const after = this.ledger.snapshot();
      const realizedDeltaCents = Math.round((after.realizedPnl - before.realizedPnl) * 100);
      this.daily.record(realizedDeltaCents, execResult.fill.timestamp);
    }

    const base = {
      approved: true,
      correlationId,
      result: execResult,
      risk: riskResult,
      snapshot: this.ledger.snapshot(),
    };

    if (this.persist) {
      try {
        const saved = await Promise.resolve(this.persistFn(this.engine, this.ledger, {
          riskState: this.daily.exportState(),
        }));
        await this._recordEquity(intent, 'committed');
        return {
          ...base,
          durable: true,
          outcome: 'committed',
          saved,
          auditFailures: [...this.auditFailures],
          auditDegraded: this.auditFailures.length > 0,
        };
      } catch (err) {
        const onDisk = loadSnapshot();
        const landed = onDisk && onDisk.ledger.getLedger().some((e) => e.orderId === intent.id);
        if (landed) {
          await this._recordEquity(intent, 'committed_ambiguous');
          return {
            ...base,
            durable: true,
            outcome: 'committed_ambiguous_resolved',
            warning: err.message,
            auditFailures: [...this.auditFailures],
            auditDegraded: this.auditFailures.length > 0,
          };
        }
        this.ledger.importState(preLedger);
        this.daily.importState(preDaily);
        this.engine.importState(preEngine);
        await this._emit('TRANSACTION_ROLLED_BACK', intent, {
          stage: 'rollback',
          reasonCode: 'persist_failed',
          outcome: 'rolled_back',
          transactionStatus: 'rolled_back',
          payload: { error: err.message },
        });
        return this._result(false, 'rolled_back', correlationId, {
          error: err.message,
          risk: riskResult,
          snapshot: this.ledger.snapshot(),
        });
      }
    }

    await this._recordEquity(intent, 'memory_only');
    return {
      ...base,
      durable: false,
      outcome: 'memory_only',
      auditFailures: [...this.auditFailures],
      auditDegraded: this.auditFailures.length > 0,
    };
  }

  _result(approved, outcome, correlationId, extra = {}) {
    return {
      approved,
      durable: false,
      outcome,
      correlationId,
      auditFailures: [...this.auditFailures],
      auditDegraded: this.auditFailures.length > 0,
      ...extra,
    };
  }

  exportRiskState() {
    return this.daily.exportState();
  }

  importRiskState(state) {
    this.daily.importState(state);
  }
}
