import { validateCandleSeries } from '../market-data/candle.mjs';
import { buildDatasetReport } from '../market-data/dataset.mjs';
import { PaperExecutionEngine } from '../execution/engine.mjs';
import { AccountingLedger } from '../accounting/ledger.mjs';
import { PaperTradingWorkflow } from '../risk/workflow.mjs';
import { StrategyRunner } from '../strategies/runner.mjs';
import { MarketDataError } from '../errors.mjs';

/**
 * Paper session that feeds validated candles into the existing workflow.
 * Does not fetch data itself. Does not duplicate accounting or risk logic.
 * Synthetic and provider data are labeled and not interchangeable.
 */

export function candleIdentity(candle, provenance = {}) {
  const provider = provenance.provider || candle.source || 'unknown';
  const symbol = provenance.symbol || candle.symbol || 'SYNTH';
  return `${provider}:${symbol}:${candle.timestamp}`;
}

/**
 * Run a paper session on an already-retrieved series.
 * Invalid series throws before any engine or ledger mutation.
 */
export async function runPaperSession(opts = {}) {
  const provenance = opts.provenance || { provider: 'synthetic', realtime: false };
  const cacheStatus = opts.cacheStatus || (provenance.provider === 'synthetic' ? 'synthetic' : 'unknown');
  const requireFresh = opts.requireFresh !== false;

  if (provenance.provider !== 'synthetic' && cacheStatus === 'stale_fallback' && requireFresh) {
    throw new MarketDataError('Stale cached data blocked paper execution. Fresh data is required.', {
      cacheStatus,
      provider: provenance.provider,
    });
  }

  let series;
  try {
    series = validateCandleSeries(opts.candles);
  } catch (err) {
    throw new MarketDataError(`Invalid market data rejected before paper execution: ${err.message}`, {
      cause: err.message,
    });
  }
  if (series.length === 0) {
    throw new MarketDataError('Empty series rejected before paper execution');
  }

  const datasetReport = buildDatasetReport(series, { expectedIntervalMs: opts.expectedIntervalMs });
  if (!datasetReport.ok) {
    throw new MarketDataError('Dataset report has errors; paper execution blocked', {
      errorCount: datasetReport.errorCount,
    });
  }

  const initialCapital = opts.initialCapital ?? 1000;
  const engine = new PaperExecutionEngine({ slippageBps: opts.slippageBps ?? 0 });
  const ledger = new AccountingLedger({ initialCapital });
  const workflow = new PaperTradingWorkflow({
    engine,
    ledger,
    riskLimits: opts.riskLimits || {},
    persist: false,
    audit: opts.audit === true,
    strategyId: 'baseline-sma-ema-rsi',
  });
  const runner = new StrategyRunner({
    workflow,
    persistRecords: false,
    audit: opts.audit === true,
  });

  const processed = new Set(opts.processed || []);
  const outcomes = [];
  const cashBefore = ledger.snapshot().cash;

  for (let i = 0; i < series.length; i++) {
    const id = candleIdentity(series[i], provenance);
    if (processed.has(id)) {
      outcomes.push({ identity: id, skipped: true, reason: 'duplicate' });
      continue;
    }
    const prefix = series.slice(0, i + 1);
    const result = await runner.run(prefix, opts.params || {});
    processed.add(id);
    outcomes.push({
      identity: id,
      skipped: false,
      signal: result.signal?.signal || null,
      duplicateSignal: !!result.duplicate,
      outcome: result.workflowResult?.outcome || null,
    });
  }

  return {
    mode: 'paper',
    synthetic: provenance.provider === 'synthetic',
    provenance: { ...provenance, realtime: false },
    cacheStatus,
    seriesCount: series.length,
    datasetReport,
    outcomes,
    processed: [...processed],
    snapshot: ledger.snapshot(),
    cashBefore,
    mutated: ledger.snapshot().cash !== cashBefore || ledger.snapshot().positionQty !== 0,
  };
}
