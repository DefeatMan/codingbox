import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, type LogRecord } from '../src/log.ts';

test('failure logs keep context while redacting credentials and excluding request objects', () => {
  const records: LogRecord[] = [];
  const log = createLogger(() => ['admin-value', 'room-value'], record => records.push(record));
  const error = Object.assign(new Error('docker -e WEDE_PASSWORD=room-value failed; admin-value\nAuthorization: Bearer bearer-value\nCookie: session=cookie-value'), {
    code: 'ECONNREFUSED', signal: 'SIGTERM',
    stderr: 'api_key=api-value token="token-value" https://user:url-password@example.test\n' + 'x'.repeat(5000),
    request: { headers: { authorization: 'unserialized-value' } }, stdout: 'unserialized-output',
  });
  log({ operation: 'room.start', roomId: 'room-id', startedAt: Date.now() - 20, error });
  const record = records[0]; const output = JSON.stringify(record);
  for (const value of ['admin-value', 'room-value', 'bearer-value', 'cookie-value', 'api-value', 'token-value', 'url-password', 'unserialized-value', 'unserialized-output']) {
    assert.ok(!output.includes(value), `leaked ${value}`);
  }
  assert.equal(record.operation, 'room.start'); assert.equal(record.roomId, 'room-id');
  assert.ok(record.durationMs >= 20); assert.equal(record.error.code, 'ECONNREFUSED');
  assert.equal(record.error.signal, 'SIGTERM'); assert.ok(record.error.stderr!.length <= 4096);
  assert.ok(output.includes('[REDACTED]'));
});

test('logging failures do not interrupt cleanup and cancellation is classified separately', () => {
  assert.doesNotThrow(() => createLogger(() => [], () => { throw new Error('sink unavailable'); })({ operation: 'cleanup', startedAt: Date.now(), error: 'failed' }));
  const records: LogRecord[] = [];
  createLogger(() => [], record => records.push(record))({ operation: 'archive.export', startedAt: Date.now(), error: new Error('Client disconnected'), outcome: 'cancelled' });
  assert.equal(records[0].level, 'info'); assert.equal(records[0].outcome, 'cancelled');
});
