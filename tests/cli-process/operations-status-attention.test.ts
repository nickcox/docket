import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Database, applicationId } from '../../src/storage/database.ts';
import { parseConfiguration } from '../../src/configuration.ts';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('R29/R04/R27: unknown profiles refuse definitions, automatic dispatch reports skips and status explains the repair', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'removed', definition: { ...definition, profile: 'worker' }, objectiveId: null }).status, 0);
  assert.equal(f.invoke('task.add', { id: 'next', definition, objectiveId: null }).status, 0);
  const before = await snapshot(f.home);
  for (const [operation, args] of [
    ['task.add', { id: 'invalid', definition: { ...definition, profile: 'absent' }, objectiveId: null }],
    ['task.update', { taskId: 'next', expectedRevision: 1, definition: { ...definition, title: 'Changed', profile: 'absent' } }],
  ] as const) {
    const refused = f.invoke(operation, args);
    assert.equal(refused.envelope.code, 'invalid_input');
    assert.equal(refused.data.field, 'profile');
    assert.deepEqual(refused.data.configuredNames, ['worker']);
    assert.deepEqual(await snapshot(f.home), before);
  }
  // Simulate a quiescent configuration change removing the task's chosen profile.
  const changed = { ...f.config, profiles: { replacement: f.config.profiles.worker }, defaultProfile: 'replacement',
    profileByKind: { code: 'replacement', report: 'replacement', review: 'replacement' } };
  await writeFile(f.file, JSON.stringify(changed));
  const parsed = await parseConfiguration(JSON.stringify(changed));
  using seed = new DatabaseSync(f.config.databasePath);
  const row = seed.prepare("SELECT payload FROM events WHERE kind = 'context.configured'").get()!;
  seed.prepare("UPDATE events SET payload = ? WHERE kind = 'context.configured'").run(JSON.stringify({ ...JSON.parse(String(row.payload)), ...parsed }));
  const stable = await snapshot(f.home);
  const named = f.invoke('attempt.dispatch', { taskId: 'removed', profile: null, dryRun: false });
  assert.equal(named.envelope.code, 'invalid_input');
  const plan = f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.equal(plan.data.taskId, 'next');
  assert.equal(plan.data.skippedTasks[0].taskId, 'removed');
  assert.match(plan.data.skippedTasks[0].reason, /worker.*not configured/);
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  const task = status.data.tasks.items.find((item: { id: string }) => item.id === 'removed');
  assert.equal(task.reason, plan.data.skippedTasks[0].reason);
  assert.match(task.nextAction.description, /Add the profile to the configuration, or change the task's profile/);
  assert.deepEqual(await snapshot(f.home), stable);
  const dispatched = f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: false }, 'automatic');
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  assert.equal(dispatched.data.attempt.taskId, 'next');
  assert.deepEqual(dispatched.data.skippedTasks, plan.data.skippedTasks);
  assert.deepEqual(f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: false }, 'automatic').data.skippedTasks, plan.data.skippedTasks);
});

test('A21: kept leases show current dirt, retention and unresolved-effect reasons with next actions', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  const attempt = dispatched.data.attempt;
  await writeFile(join(attempt.allocation.path, 'untracked'), 'Keep this work');
  const accepted = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false });
  assert.equal(accepted.envelope.code, 'workspace_dirty');
  assert.equal(f.invoke('attempt.show', { attemptId: attempt.id }).data.leaseState, 'held');
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  const attention = status.data.attempts.items.find((item: any) => item.id === attempt.id);
  assert.match(attention.reason, /workspace_dirty/);
  assert.equal(attention.nextAction.operation, 'attempt.return');
  assert.ok(attention.nextAction.description);

  // A later status read checks current retention, not just the failed automatic return.
  f.git('update-ref', attempt.specification.outputRef, attempt.specification.startingCommit);
  const unretained = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items[0];
  assert.match(unretained.reason, /candidate_moved/);
  assert.ok(unretained.nextAction.description);
  f.git('update-ref', attempt.specification.outputRef, attempt.candidate.commit);

  const db = await Database.open(f.config.databasePath, { readOnly: false,
    location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } });
  try {
    const caller = { kind: 'person' as const, id: String(userInfo().uid) };
    const [claim] = await db.registerClaims([{ resourceKey: 'uncertain-return-condition', role: 'maintenance', generation: 'condition',
      ownerRef: caller, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], caller);
    const command = await db.recordCommand({ requestKey: 'effect-condition', operation: 'test', caller, fingerprint: 'condition', input: {} });
    const executor = { claimId: claim!.id, generation: claim!.generation };
    const effect = await db.recordEffect({ requestKey: 'unresolved-condition', operation: 'workspace.test', caller, fingerprint: 'condition',
      input: {}, parentId: command.id, executor, attemptId: attempt.id, target: { kind: 'workspace', reference: attempt.allocation } });
    await db.claimEffect(effect.id, executor);
    await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: 'Lost owner response' });
  } finally { db.close(); }
  const unresolved = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items[0];
  assert.match(unresolved.reason, /unresolved effect/);
  assert.ok(unresolved.nextAction.description);
});

test('R27/A52: failed checks appear in compact attention status with a reason and next action', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.docket'));
  await writeFile(join(f.repo, '.docket', 'checks.json'), JSON.stringify({ version: 1, fast: [],
    full: [{ name: 'fails', command: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 5000 }] }));
  f.git('add', '.'); f.git('commit', '-qm', 'Add failing check');
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  assert.equal(status.status, 0, JSON.stringify(status.envelope));
  const attempt = status.data.attempts.items[0];
  assert.equal(attempt.checksState, 'failed');
  assert.equal(attempt.reason, 'Candidate checks failed.');
  assert.equal(attempt.nextAction.operation, 'attempt.show');
  assert.equal(status.data.tasks.items[0].holdReason, 'checks_failed');
  assert.equal(JSON.stringify(status.data).includes(definition.instructions), false);
  const done = f.invoke('task.done', { taskId: 'feature', note: 'Person judgement' });
  assert.equal(done.status, 0, JSON.stringify(done.envelope));
  assert.equal(done.data.task.holdReason, null);
  const after = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
  assert.deepEqual(after.tasks.items, []);
  assert.deepEqual(after.attempts.items, []);
});

for (const decision of ['done', 'discard', 'return']) {
  test(`R03/R27: ${decision} removes an unaccepted candidate from attention status`, async t => {
    const f = await fixture(t);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
    assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
    const attemptId = dispatched.data.attempt.id;
    assert.equal(f.invoke('task.show', { taskId: 'feature' }).data.task.holdReason, 'awaiting_acceptance');
    if (decision === 'done') {
      const done = f.invoke('task.done', { taskId: 'feature', note: 'Person judgement' });
      assert.equal(done.status, 0, JSON.stringify(done.envelope));
      assert.equal(done.data.task.state, 'done');
      assert.equal(done.data.task.holdReason, null);
    }
    if (decision === 'discard' || decision === 'return') {
      const result = decision === 'discard'
        ? f.invoke('attempt.discard', { attemptId, confirmDiscard: true, reason: 'Not needed', dryRun: false })
        : f.invoke('attempt.return', { attemptId, dryRun: false });
      assert.equal(result.status, 0, JSON.stringify(result.envelope));
      assert.equal(result.data.attempt.leaseState, 'returned');
    }
    const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data;
    assert.equal(status.attempts.items[0].reason, null);
    assert.equal(status.attempts.items[0].nextAction, null);
    const attention = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
    assert.deepEqual(attention.attempts.items, []);
    if (decision === 'done') assert.deepEqual(attention.tasks.items, []);
  });
}

test('A16/A49/R30: stale claim and uncertain effect block dispatch until scoped person resolutions; plans do not write', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const options = { readOnly: false, location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } };
  using db = await Database.open(f.config.databasePath, options);
  const person = { kind: 'person' as const, id: String(userInfo().uid) };
  const [claim] = await db.registerClaims([{ resourceKey: 'owner', role: 'maintenance', generation: 'test-generation', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const command = await db.recordCommand({ requestKey: 'original', operation: 'original', caller: person, fingerprint: 'original', input: {} });
  const executor = { claimId: claim!.id, generation: claim!.generation };
  const effect = await db.recordEffect({ requestKey: 'uncertain', operation: 'worker.test', caller: person, fingerprint: 'effect', input: {},
    parentId: command.id, executor, target: { kind: 'worker', reference: { launcher: 'pi', ownerId: 'lost-owner' } } });
  await db.claimEffect(effect.id, executor);
  await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: 'Lost response' });
  await db.refreshClaim(executor, new Date(Date.now() - 60000).toISOString(), person);
  db.close();
  const attention = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
  assert.equal(attention.claims.length, 1);
  assert.match(attention.claims[0].reason, /stale/u);
  assert.equal(attention.claims[0].nextAction.operation, 'claim.resolve');
  assert.equal(attention.effects.length, 1);
  assert.match(attention.effects[0].reason, /uncertain/u);
  assert.equal(attention.effects[0].nextAction.operation, 'request.show');
  for (const item of [...attention.tasks.items, ...attention.claims, ...attention.effects, ...attention.blockers]) {
    assert.ok(item.reason, 'R27: every attention item explains why');
    assert.ok(item.nextAction.description, 'R27: every attention item has a next action');
  }
  const dispatch = () => f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: true });
  assert.equal(dispatch().status, 1);
  const resolve = { claimId: claim!.id, evidence: 'Inspected the exact owner and stopped its processes', confirmStopped: true, dryRun: true };
  assert.equal(f.invoke('claim.resolve', { ...resolve, confirmStopped: false }).envelope.code, 'process_confirmation_required');
  const bytes = await readFile(f.config.databasePath);
  assert.equal(f.invoke('claim.resolve', resolve).status, 0);
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  assert.equal(dispatch().status, 1, 'age and a plan are not proof');
  assert.equal(f.invoke('claim.resolve', { ...resolve, dryRun: false }, 'resolve-claim').status, 0);
  assert.equal(dispatch().status, 1, 'the uncertain effect still blocks');
  const effectArgs = { effectId: effect.id, outcome: 'not_happened', evidence: 'Exact owner inspected; no activation was sent', confirmStopped: true, dryRun: false };
  assert.equal(f.invoke('effect.resolve', { ...effectArgs, evidence: ' ' }).status, 2);
  assert.equal(f.invoke('effect.resolve', effectArgs, 'resolve-effect').status, 0);
  assert.equal(f.invoke('effect.resolve', effectArgs, 'resolve-effect').status, 0, 'resolution is replayable');
  assert.equal(dispatch().status, 0);
});
