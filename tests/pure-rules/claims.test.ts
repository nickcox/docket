import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heartbeatStatus } from '../../src/storage/claims.ts';

test('A16/R08: heartbeat age is fresh only in [0, 30000) milliseconds', () => {
  const now = Date.parse('2026-11-08T09:00:00.000Z');
  for (const age of [0, 29_999, 30_000, 90_000, -1]) {
    assert.equal(heartbeatStatus(new Date(now - age).toISOString(), now),
      age < 0 ? 'future_dated' : age < 30_000 ? 'fresh' : 'stale');
  }
  for (const value of ['unreadable', '', null, undefined, {}, 123]) assert.equal(heartbeatStatus(value, now), 'unreadable');
  assert.throws(() => heartbeatStatus('2026-11-08', NaN), /finite/);
});
