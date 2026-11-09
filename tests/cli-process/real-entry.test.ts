import assert from 'node:assert/strict';
import test from 'node:test';
import { definition, fixture, realEntry } from '../helpers/cli-operations.ts';

test('R29/R31/R38: the real CLI dispatch checks profile trust and secures the Pi directory', async t => {
  const f = await fixture(t, 'code-result', realEntry);
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
  const result = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.data.attempt.outcome, 'completed');
  assert.equal(result.data.attempt.executionOpen, false);
});
