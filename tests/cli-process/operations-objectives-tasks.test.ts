import assert from 'node:assert/strict';
import test from 'node:test';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('R18/R19/R28: objective operations replay atomically, validate budgets and dispatch linked tasks with unchanged dry-run state', async t => {
  const f = await fixture(t);
  const add = { id: 'goal', request: 'Implement the feature', criteria: ['Works'], scope: '', constraints: '',
    permissions: { dispatch: false }, budget: { maxCost: 0, currency: 'AUD', maxTokens: 0, maxWorkerTimeMs: 0 }, deadline: '2020-01-01T00:00:00+10:00' };
  const goal = f.invoke('objective.add', add, 'add-goal');
  assert.equal(goal.status, 0, JSON.stringify(goal.envelope));
  const recorded = await snapshot(f.home);
  assert.deepEqual(f.invoke('objective.add', add, 'add-goal').data, goal.data);
  assert.deepEqual(await snapshot(f.home), recorded);
  const bad = f.invoke('objective.update', { objectiveId: 'goal', expectedRevision: 1, criteria: ['Works'], scope: '', constraints: '',
    permissions: {}, budget: { ...add.budget, currency: null }, deadline: null });
  assert.equal(bad.envelope.code, 'invalid_input');
  assert.deepEqual(await snapshot(f.home), recorded);
  const update = { objectiveId: 'goal', expectedRevision: 1, criteria: ['Works'], scope: 'Repository', constraints: '', permissions: {}, budget: { maxCost: null, currency: 'USD', maxTokens: 10000, maxWorkerTimeMs: 60000 }, deadline: null };
  const updated = f.invoke('objective.update', update, 'update-goal');
  assert.equal(updated.status, 0, JSON.stringify(updated.envelope));
  assert.deepEqual(f.invoke('objective.update', update, 'update-goal').data, updated.data);
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: 'goal' }).status, 0);
  assert.equal(f.invoke('task.move', { taskId: 'feature', expectedRevision: 1, objectiveId: null }, 'unlink').status, 0);
  assert.equal(f.invoke('task.move', { taskId: 'feature', expectedRevision: 2, objectiveId: 'goal' }, 'link').status, 0);
  const stable = await snapshot(f.home);
  const plan = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.deepEqual(await snapshot(f.home), stable);
  // Persons are not restricted by supervisor permissions, but budgets apply to every dispatch.
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch-goal');
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  assert.equal(dispatched.data.attempt.specification.objectiveId, 'goal');
  const accepted = f.invoke('attempt.accept', { attemptId: dispatched.data.attempt.id, candidateCommit: null, overrideReason: null, dryRun: false }, 'accept-goal');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.equal(accepted.data.leaseReturn.state, 'returned');
  const abandoned = f.invoke('objective.abandon', { objectiveId: 'goal', reason: 'Pause' }, 'abandon-goal');
  assert.equal(abandoned.status, 0, JSON.stringify(abandoned.envelope));
  const reopened = f.invoke('objective.reopen', { objectiveId: 'goal', reason: 'Resume' }, 'reopen-goal');
  assert.equal(reopened.status, 0, JSON.stringify(reopened.envelope));
  const finished = await snapshot(f.home);
  assert.deepEqual(f.invoke('objective.reopen', { objectiveId: 'goal', reason: 'Resume' }, 'reopen-goal').data, reopened.data);
  assert.deepEqual(await snapshot(f.home), finished);
  assert.equal(f.invoke('objective.show', { objectiveId: 'goal' }).data.objective.state, 'open');
});

test('R28/R27: strict task inputs, mutations, revisions, replay and paginated reads share one envelope', async t => {
  const f = await fixture(t);
  for (const id of ['first', 'second']) assert.equal(f.invoke('task.add', { id, definition, objectiveId: null }).status, 0);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Wait', caller: 'person' }).status, 2);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Wait' }, 'hold').status, 0);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Changed' }, 'hold').envelope.code, 'request_input_mismatch');
  assert.equal(f.invoke('task.release', { taskId: 'first' }).status, 0);
  const dependency = { taskId: 'first', blockerId: 'second' };
  assert.equal(f.invoke('task.block', dependency, 'block').status, 0);
  assert.equal(f.invoke('task.block', dependency, 'block').status, 0, 'R28: replay is not a duplicate mutation');
  const blocked = f.invoke('task.show', { taskId: 'first' }).data.task;
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockedBy, ['second']);
  const pageArgs = { after: null, limit: 100 };
  const ready = () => f.invoke('task.list', { state: null, readyOnly: true, page: pageArgs }).data.items.map((task: { id: string }) => task.id);
  assert.deepEqual(ready(), ['second']);
  const status = f.invoke('status.show', { attentionOnly: false, page: pageArgs }).data.tasks.items;
  assert.equal(status.find((task: { id: string }) => task.id === 'first').ready, false);
  assert.deepEqual(status.find((task: { id: string }) => task.id === 'first').blockedBy, ['second']);
  assert.equal(f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: true }).data.taskId, 'second');
  const before = await snapshot(f.home);
  for (const args of [dependency, { taskId: 'first', blockerId: 'first' }, { taskId: 'first', blockerId: 'missing' },
    { taskId: 'missing', blockerId: 'first' }, { taskId: 'second', blockerId: 'first' }]) {
    assert.equal(f.invoke('task.block', args).envelope.code, 'policy_refused');
    assert.deepEqual(await snapshot(f.home), before, 'R25: refusal changes nothing');
  }
  assert.equal(f.invoke('task.unblock', dependency, 'unblock').status, 0);
  assert.equal(f.invoke('task.unblock', dependency, 'unblock').status, 0);
  const unblocked = f.invoke('task.show', { taskId: 'first' }).data.task;
  assert.equal(unblocked.decisionRevision, blocked.decisionRevision + 1);
  assert.deepEqual(unblocked.blockedBy, []);
  assert.deepEqual(ready(), ['first', 'second']);
  assert.equal(f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: true }).data.taskId, 'first');
  assert.equal(f.invoke('task.reorder', { orderedTaskIds: ['second', 'first'] }).status, 0);
  assert.equal(f.invoke('task.done', { taskId: 'first', note: 'Person judgement' }).status, 0);
  assert.equal(f.invoke('task.reopen', { taskId: 'first', note: null }).status, 0);
  assert.equal(f.invoke('task.add', { id: 'review', definition: { ...definition, kind: 'review' }, objectiveId: null }).status, 2);
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 1, definition: { ...definition, kind: 'review' } }).status, 1);
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 99, definition }).envelope.code, 'task_changed');
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 1, definition: { ...definition, title: 'New title' } }).status, 0);
  const page = f.invoke('task.list', { state: null, readyOnly: false, page: { after: null, limit: 1 } });
  assert.equal(page.data.items[0].id, 'second'); assert.equal(page.data.next, 'second');
});
