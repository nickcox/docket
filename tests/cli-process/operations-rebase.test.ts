import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from '../../src/storage/database.ts';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('R27/R30: moved targets name exact commits and rebase action; target restrictions remain policy_refused', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  const attempt = dispatched.data.attempt;
  f.git('commit', '--allow-empty', '-qm', 'Target moved independently');
  const targetCommit = f.git('rev-parse', 'main');
  for (const dryRun of [true, false]) {
    const before = await snapshot(f.home);
    const refused = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun });
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope.code, 'not_fast_forward');
    assert.deepEqual(refused.data, { attemptId: attempt.id, targetRef: 'refs/heads/main', targetCommit, candidateCommit: attempt.candidate.commit });
    assert.equal(refused.envelope.nextAction.operation, 'attempt.rebase');
    assert.deepEqual(refused.envelope.nextAction.args, { attemptId: attempt.id, dryRun: true });
    assert.ok(refused.envelope.nextAction.description);
    assert.deepEqual(await snapshot(f.home), before, 'Refusal preserves work and records');
  }
  for (const restrictions of [{ forbid: [], protectedTargets: ['main'] }, { forbid: ['local-merge'], protectedTargets: [] }]) {
    await writeFile(join(f.home, '.config', 'docket', 'finalisation.json'), JSON.stringify({ version: 1, ...restrictions }));
    // Planning/execution combinations run with fake owners in the operation
    // tests; keep real CLI policy loading and refusal for each restriction here.
    const refused = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false });
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope.code, 'policy_refused');
    assert.equal(refused.envelope.nextAction, null);
  }
  assert.equal(f.git('rev-parse', attempt.specification.outputRef), attempt.candidate.commit);
  assert.equal(f.git('rev-parse', 'main'), targetCommit);
  await writeFile(join(f.home, '.config', 'docket', 'finalisation.json'), JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  const beforeRebase = await snapshot(f.home);
  const rebasePlan = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: true });
  assert.equal(rebasePlan.status, 0, JSON.stringify(rebasePlan.envelope));
  assert.deepEqual(await snapshot(f.home), beforeRebase);
  const rebased = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'rebase');
  assert.equal(rebased.status, 0, JSON.stringify(rebased.envelope) + rebased.stderr);
  assert.deepEqual(rebased.data.steps, rebasePlan.data.steps);
  assert.notEqual(rebased.data.attempt.candidate.id, attempt.candidate.id);
  const commit = rebased.data.attempt.candidate.commit;
  assert.equal(f.git('rev-parse', attempt.specification.outputRef), commit);
  assert.equal(f.git('rev-parse', `refs/docket/original/${attempt.specification.databaseId}/${attempt.id}`), attempt.candidate.commit);
  assert.equal(f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'rebase').data.attempt.candidate.commit, commit);
  const accepted = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false }, 'accept-rebased');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.equal(f.git('rev-parse', 'main'), commit);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, dryRun: false }, 'return-rebased');
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
});

for (const sameLines of [false, true]) {
  test(`R14: repeated rebase excludes conflicting target history${sameLines ? ' when later target changes touch the same lines' : ''}`, async t => {
    const f = await fixture(t);
    assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
    const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
    assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
    const attempt = dispatched.data.attempt;
    const original = attempt.candidate.commit;
    const targetChange = async (text: string) => {
      await writeFile(join(f.repo, 'README'), text + '\n');
      f.git('commit', '-qam', text);
    };
    // Replaying the first target patch onto the final target would conflict.
    await targetChange('Intermediate target');
    await targetChange('First target');
    const firstTarget = f.git('rev-parse', 'HEAD');
    const first = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'first-rebase');
    assert.equal(first.status, 0, JSON.stringify(first.envelope));
    if (sameLines) await targetChange('Second target');
    else f.git('commit', '--allow-empty', '-qm', 'Target advances');
    const secondTarget = f.git('rev-parse', 'HEAD');
    // Repeated-rebase planning is covered with fake owners in completion.test.ts;
    // this boundary proves that real Git replays only the candidate's changes.
    const second = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'second-rebase');
    assert.equal(second.status, 0, JSON.stringify(second.envelope));
    const commit = second.data.attempt.candidate.commit;
    assert.equal(f.git('rev-list', '--count', `${secondTarget}..${commit}`), '1');
    assert.equal(f.git('rev-parse', `${commit}^`), secondTarget);
    assert.equal(f.git('diff', `${original}^`, original), f.git('diff', secondTarget, commit));
    assert.equal(f.git('show', `${commit}:README`), sameLines ? 'Second target' : 'First target');
    using db = await Database.open(f.config.databasePath, { readOnly: true,
      location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } });
    const event = db.events().findLast(e => e.kind === 'output.rebased' && e.attemptId === attempt.id)!;
    assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased],
      [first.data.attempt.candidate.commit, firstTarget, secondTarget, commit]);
  });
}
