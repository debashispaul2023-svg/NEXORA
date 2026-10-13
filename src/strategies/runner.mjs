import { evaluateBaseline, STRATEGY_ID, STRATEGY_VERSION } from './baseline.mjs';
import { makeEvaluationRecord } from './interface.mjs';
import { appendEvaluation, evaluationKey } from '../analytics/records.mjs';
import { appendEvent, EVENT_SCHEMA_VERSION } from '../audit/events.mjs';

/**
 * Strategy runner.
 * Evaluates a strategy and, for actionable signals, submits an order intent
 * through the supplied PaperTradingWorkflow.
 *
 * Emits SIGNAL_RECORDED when audit is enabled (default true).
 * HOLD produces no order event. Order id = strategyId-timestamp.
 */

export class StrategyRunner {
  /**
   * @param {object} opts
   * @param {import('../risk/workflow.mjs').PaperTradingWorkflow} opts.workflow
   * @param {function} [opts.evaluate]
   * @param {boolean} [opts.persistRecords=false]
   * @param {boolean} [opts.audit=true]
   * @param {function} [opts.appendEventFn]
   */
  constructor({ workflow, evaluate = evaluateBaseline, persistRecords = false, audit = true, appendEventFn = null } = {}) {
    if (!workflow) throw new Error('workflow is required');
    this.workflow = workflow;
    this.evaluate = evaluate;
    this.persistRecords = persistRecords;
    this.audit = audit;
    this.appendEventFn = appendEventFn || appendEvent;
    this.records = [];
    this.evaluatedKeys = new Set();
  }

  async run(candles, params = {}) {
    const signal = this.evaluate(candles, params);
    const key = `${signal.strategyId}:${signal.timestamp}`;

    if (this.evaluatedKeys.has(key)) {
      const prior = this.records.find((r) => r.strategyId === signal.strategyId && r.timestamp === signal.timestamp);
      return { signal, record: prior, duplicate: true, persisted: false };
    }

    let workflowResult = null;
    let orderId = null;

    if (this.audit) {
      try {
        await this.appendEventFn({
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: `SIGNAL_RECORDED:${signal.strategyId}:${signal.timestamp}`,
          eventType: 'SIGNAL_RECORDED',
          occurredAt: signal.timestamp,
          source: 'StrategyRunner',
          correlationId: signal.actionable ? `${signal.strategyId}-${signal.timestamp}` : null,
          strategyId: signal.strategyId,
          strategyVersion: signal.strategyVersion,
          candleTimestamp: signal.timestamp,
          payload: { signal: signal.signal, reason: signal.reason, actionable: signal.actionable },
        });
      } catch {
        /* audit failure is non-fatal */
      }
    }

    if (signal.actionable && (signal.signal === 'BUY' || signal.signal === 'SELL')) {
      orderId = `${signal.strategyId}-${signal.timestamp}`;
      const intent = {
        id: orderId,
        type: 'MARKET',
        side: signal.signal,
        quantity: signal.quantity || 1,
        timestamp: signal.timestamp,
        symbol: 'SYNTH',
      };
      workflowResult = await this.workflow.submitOrder(intent, candles);
    }


    const record = makeEvaluationRecord({
      strategyId: signal.strategyId,
      strategyVersion: signal.strategyVersion,
      timestamp: signal.timestamp,
      signal: signal.signal,
      reason: signal.reason,
      indicators: signal.indicators,
      candleTimestamp: signal.timestamp,
      orderId,
      riskDecision: workflowResult?.risk || null,
      executionOutcome: workflowResult
        ? { approved: workflowResult.approved, durable: workflowResult.durable, outcome: workflowResult.outcome }
        : null,
    });

    this.records.push(record);
    this.evaluatedKeys.add(key);

    let persisted = false;
    if (this.persistRecords) {
      try {
        const result = appendEvaluation(record);
        persisted = result.appended;
      } catch {
        persisted = false;
      }
    }

    return { signal, record, workflowResult, duplicate: false, persisted };
  }

  getRecords() {
    return [...this.records];
  }
}

export { STRATEGY_ID, STRATEGY_VERSION, evaluationKey };
