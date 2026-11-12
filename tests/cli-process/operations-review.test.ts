import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('R13/A28: CLI review creation, exact dispatch and verdict views share the worker protocol', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'source', definition, objectiveId: null }).status, 0);
  const source = f.invoke('attempt.dispatch', { taskId: 'source', profile: null, dryRun: false });
  assert.equal(source.status, 0, JSON.stringify(source.envelope));
  const attemptId = source.data.attempt.id;
  const before = await snapshot(f.home);
  const plan = f.invoke('attempt.review', { attemptId, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.deepEqual(await snapshot(f.home), before, 'Review planning is read-only');
  const created = f.invoke('attempt.review', { attemptId, dryRun: false }, 'review');
  assert.equal(created.status, 0, JSON.stringify(created.envelope));
  const task = created.data.task;
  assert.deepEqual(f.invoke('attempt.review', { attemptId, dryRun: false }, 'review').data.task, task);
  assert.equal(f.invoke('task.update', { taskId: task.id, expectedRevision: task.definitionRevision,
    definition: { ...definition, kind: 'review', instructions: 'Replace target' } }).status, 1);
  // Review dispatch pins the target, starts Pi and verifies a safe lease return.
  // Its many Git/Treehouse process starts need headroom on Windows CI.
  const review = f.invoke('attempt.dispatch', { taskId: task.id, profile: null, dryRun: false }, undefined, undefined, 60000);
  assert.equal(review.status, 0, JSON.stringify(review.envelope));
  assert.equal(review.data.attempt.specification.startingCommit, source.data.attempt.candidate.commit);
  assert.deepEqual(review.data.leaseReturn, { state: 'returned', reason: null });
  assert.equal(review.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('task.show', { taskId: task.id }).data.task.state, 'done');
  const shown = f.invoke('attempt.show', { attemptId }).data;
  assert.equal(shown.review.current.payload.verdict, 'passed');
  assert.equal(shown.review.tasks[0].id, task.id);
  assert.equal(shown.acceptance, null);
  assert.equal(f.invoke('task.show', { taskId: 'source' }).data.task.holdReason, 'awaiting_acceptance');
  const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } });
  assert.equal(status.data.attempts.items.find((a: { id: string }) => a.id === attemptId).review.current.payload.verdict, 'passed');
  using sql = new DatabaseSync(f.config.databasePath);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM requests WHERE attempt_id = ? AND operation = 'checks.run'").get(review.data.attempt.id)!.n, 0);
});

for (const scenario of ['held', 'failed', 'replaced-candidate', 'dirty-untracked', 'dirty-tracked']) {
  test(`R11/R13/A21: review dispatch safe return – ${scenario}`, async t => {
    const f = await fixture(t);
    f.invoke('task.add', { id: 'source', definition, objectiveId: null });
    const source = f.invoke('attempt.dispatch', { taskId: 'source', profile: null, dryRun: false }).data.attempt;
    const created = f.invoke('attempt.review', { attemptId: source.id, dryRun: false });
    assert.equal(created.status, 0, JSON.stringify(created.envelope));
    const task = created.data.task;
    if (scenario === 'replaced-candidate') {
      using sql = new DatabaseSync(f.config.databasePath);
      sql.prepare('UPDATE attempts SET candidate = ? WHERE id = ?').run(
        JSON.stringify({ ...source.candidate, id: 'replacement' }), source.id);
    }
    const mode = scenario.startsWith('dirty-') ? `review-${scenario}`
      : scenario === 'held' || scenario === 'failed' ? `${scenario}-result` : 'code-result';
    const args = { taskId: task.id, profile: null, dryRun: false };
    // The held case starts 80 Git, nine Treehouse and one Pi process directly.
    // Target pinning and repeated return-safety checks make Windows starts slow;
    // allow this dispatch 60 seconds, but keep its replay at the default limit.
    const review = f.invoke('attempt.dispatch', args, 'review-dispatch', mode, 60000);
    assert.equal(review.status, 0, JSON.stringify(review.envelope));
    const attempt = review.data.attempt;
    const dirty = scenario.startsWith('dirty-');
    assert.equal(attempt.outcome, scenario === 'held' || scenario === 'failed' ? scenario : 'completed');
    assert.equal(attempt.leaseState, dirty ? 'held' : 'returned');
    assert.equal(review.data.leaseReturn.state, dirty ? 'kept' : 'returned');
    const replay = f.invoke('attempt.dispatch', args, 'review-dispatch', mode);
    assert.equal(replay.status, 0, JSON.stringify(replay.envelope));
    assert.equal(replay.data.leaseReturn.state, review.data.leaseReturn.state);
    const shown = f.invoke('attempt.show', { attemptId: source.id }).data;
    assert.equal(shown.review.findings.length, dirty ? 1 : 0);
    if (dirty) {
      assert.match(review.data.leaseReturn.reason, /workspace_dirty/);
      const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
      const attention = status.data.attempts.items.find((item: any) => item.id === attempt.id);
      assert.match(attention.reason, /workspace_dirty/);
      assert.equal(attention.nextAction.operation, 'attempt.return');
      assert.ok(attention.nextAction.description);
      const path = join(attempt.allocation.path, scenario === 'dirty-untracked' ? 'unfinished.txt' : 'implementation.txt');
      assert.match(await readFile(path, 'utf8'), /review work/);
    }
  });
}
