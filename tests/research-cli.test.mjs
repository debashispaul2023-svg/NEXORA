import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchArgs, runResearchCli } from '../src/research/cli.mjs';

test('parseResearchArgs defaults and flags', () => {
  const empty = parseResearchArgs([]);
  assert.equal(empty.backtest, false);
  assert.equal(empty.walkForward, false);
  assert.equal(empty.count, 40);

  const flags = parseResearchArgs([
    '--backtest',
    '--walk-forward',
    '--count=20',
    '--capital=500',
    '--warmup-bars=3',
    '--eval-bars=5',
    '--step-bars=5',
  ]);
  assert.equal(flags.backtest, true);
  assert.equal(flags.walkForward, true);
  assert.equal(flags.count, 20);
  assert.equal(flags.capital, 500);
  assert.equal(flags.warmupBars, 3);
  assert.equal(flags.evalBars, 5);
  assert.equal(flags.stepBars, 5);
});

test('parseResearchArgs rejects invalid count', () => {
  assert.throws(() => parseResearchArgs(['--count=0']), /count/);
  assert.throws(() => parseResearchArgs(['--count=-1']), /count/);
});

test('runResearchCli with no research flags does nothing', async () => {
  const result = await runResearchCli(parseResearchArgs([]));
  assert.equal(result.ran, false);
});

test('runResearchCli synthetic backtest completes', async () => {
  const flags = parseResearchArgs(['--backtest', '--count=15', '--capital=1000']);
  const result = await runResearchCli(flags);
  assert.equal(result.ran, true);
});

test('runResearchCli synthetic walk-forward completes', async () => {
  const flags = parseResearchArgs([
    '--walk-forward',
    '--count=30',
    '--warmup-bars=5',
    '--eval-bars=10',
    '--step-bars=10',
  ]);
  const result = await runResearchCli(flags);
  assert.equal(result.ran, true);
});
