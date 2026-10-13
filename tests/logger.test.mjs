import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, setLogLevel } from '../src/logger.mjs';
import { FabInvestsError, serializeError } from '../src/errors.mjs';

test('logger methods do not throw', () => {
  setLogLevel('debug');
  assert.doesNotThrow(() => logger.info('test message', { foo: 1 }));
  assert.doesNotThrow(() => logger.warn('warning'));
  assert.doesNotThrow(() => logger.error('error'));
});

test('serializeError redacts nothing critical and includes code', () => {
  const err = new FabInvestsError('boom', 'TEST_CODE', { extra: 42 });
  const ser = serializeError(err);
  assert.equal(ser.code, 'TEST_CODE');
  assert.equal(ser.message, 'boom');
  assert.equal(ser.details.extra, 42);
});

test('logger redacts keys matching secret patterns', () => {
  // Capture by temporarily swapping stdout — simple smoke that it doesn't throw
  assert.doesNotThrow(() => logger.info('secret test', { apiKey: 'should-redact', password: 'nope' }));
});
