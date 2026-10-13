/**
 * Process-local mutual exclusion.
 *
 * Reentrant within the same async call chain is not supported by a simple
 * chain; nested calls must not re-acquire. Callers that already hold the
 * workflow lock should use the unlocked append helpers.
 *
 * This is NOT multi-process safe.
 */

let chain = Promise.resolve();
let depth = 0;

export function withProcessLock(fn) {
  if (depth > 0) {
    // Already inside a locked section in this turn; run directly to avoid deadlock.
    return Promise.resolve().then(() => fn());
  }
  const run = chain.then(() => {
    depth += 1;
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        depth -= 1;
      });
  }, () => {
    depth += 1;
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        depth -= 1;
      });
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}
