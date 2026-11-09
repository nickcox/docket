import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';
import { definition, fixture, snapshot } from '../helpers/cli-operations.ts';

test('M3/R27/R30: real CLI adds, plans, dispatches synthetic Pi, accepts local-merge and returns its lease', async t => {
  const f = await fixture(t);
  const add = f.invoke('task.add', { id: 'feature', definition, objectiveId: null }, 'add');
  assert.equal(add.status, 0, JSON.stringify(add.envelope));
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }, 'add').status, 0);
  const before = await snapshot(f.home);
  const plan = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.deepEqual(await snapshot(f.home), before);
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope) + dispatched.stderr);
  assert.deepEqual(dispatched.data.steps, plan.data.steps);
  for (const entry of plan.data.steps) assert.ok(dispatched.stderr.includes(entry.operation));
  const attempt = dispatched.data.attempt;
  assert.equal(attempt.outcome, 'completed'); assert.equal(attempt.executionOpen, false);
  assert.equal(f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch').data.attempt.id, attempt.id);
  const detail = f.invoke('attempt.show', { attemptId: attempt.id }).data;
  assert.equal(detail.specification.task.instructions, definition.instructions, 'R27: attempt.show retains full instructions');
  const checksInput = { attemptId: attempt.id, commit: detail.candidate.commit, dryRun: true };
  const beforeChecksPlan = await snapshot(f.home);
  const checksPlan = f.invoke('checks.run', checksInput, 'explicit-checks');
  assert.equal(checksPlan.status, 0, JSON.stringify(checksPlan.envelope));
  assert.deepEqual(checksPlan.data.steps, [], 'R15/R30: matching successful evidence needs no commands');
  assert.deepEqual(await snapshot(f.home), beforeChecksPlan);
  const checked = f.invoke('checks.run', { ...checksInput, dryRun: false }, 'explicit-checks');
  assert.equal(checked.status, 0, JSON.stringify(checked.envelope));
  assert.equal(checked.data.request.result.status, 'passed');
  assert.equal(f.invoke('checks.run', { ...checksInput, dryRun: false }, 'explicit-checks').data.request.id, checked.data.request.id);
  const readBefore = await snapshot(f.home);
  const request = f.invoke('request.show', { requestId: 'dispatch' });
  assert.equal(request.status, 0, JSON.stringify(request.envelope));
  assert.equal(request.data.requestId, 'dispatch');
  assert.equal(request.data.operation, 'attempt.dispatch');
  assert.equal(request.data.attemptId, attempt.id);
  assert.equal(request.data.caller.kind, 'person');
  assert.equal(request.data.parent, null);
  assert.equal(request.data.target, null);
  assert.ok(request.data.input);
  assert.ok(request.data.effectsTotal > 0);
  const effectRequest = f.invoke('request.show', { requestId: detail.effects[0].requestKey });
  assert.equal(effectRequest.status, 0, JSON.stringify(effectRequest.envelope));
  assert.equal(effectRequest.data.attemptId, attempt.id);
  assert.equal(effectRequest.data.parent.id, request.data.id);
  assert.ok(effectRequest.data.target.kind);
  assert.ok(effectRequest.data.result);
  assert.equal(f.invoke('request.show', { requestId: request.data.id }).envelope.code, 'invalid_input');
  assert.equal(f.invoke('request.show', { requestId: 'absent' }).envelope.code, 'invalid_input');
  assert.equal(f.invoke('request.show', { requestId: 'dispatch', caller: { kind: 'person' } }).envelope.code, 'invalid_input');
  assert.deepEqual(await snapshot(f.home), readBefore, 'R09/R27: request inspection is read-only');
  for (const attentionOnly of [false, true]) {
    const status = f.invoke('status.show', { attentionOnly, page: { after: null, limit: 100 } }).data;
    assert.equal(JSON.stringify(status).includes(definition.instructions), false, 'R27: status excludes task instructions');
    assert.equal(JSON.stringify(status).includes('specification'), false);
    assert.equal(status.attempts.items[0].candidateCommit, attempt.candidate.commit);
    assert.equal(status.attempts.items[0].checksState, 'passed');
    assert.match(status.attempts.items[0].reason, /awaiting acceptance/u);
    assert.equal(status.attempts.items[0].nextAction.operation, 'attempt.accept');
    for (const item of [...status.tasks.items, ...status.attempts.items]) {
      assert.ok(item.reason); assert.ok(item.nextAction.description);
    }
    const schema = findOperation('status.show')!.outputSchema;
    const extra = structuredClone(status); extra.attempts.items[0].specification = {};
    assert.notEqual(validateSchema(schema, extra), null, 'A52: catalogue refuses full attempt detail in status');
    const missing = structuredClone(status); delete missing.tasks.items[0].ready;
    assert.notEqual(validateSchema(schema, missing), null, 'A52: catalogue requires compact task fields');
  }
  const acceptArgs = { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: true };
  const bytes = await snapshot(f.home);
  const acceptancePlan = f.invoke('attempt.accept', acceptArgs);
  assert.equal(acceptancePlan.status, 0, JSON.stringify(acceptancePlan.envelope));
  assert.deepEqual(await snapshot(f.home), bytes);
  const accepted = f.invoke('attempt.accept', { ...acceptArgs, dryRun: false }, 'accept');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.deepEqual(accepted.data.steps, acceptancePlan.data.steps);
  assert.equal(f.git('rev-parse', 'main'), attempt.candidate.commit);
  assert.equal(accepted.data.leaseReturn.state, 'returned', 'A21: local-merge automatically returns a safe lease');
  assert.equal(accepted.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items.length, 0);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, dryRun: false }, 'return');
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('task.show', { taskId: 'feature' }).data.task.state, 'done');
  // A58/R40: the CLI cleans only diagnostics and old dispatch replay stays read-only.
  const diagnostics = join(f.config.stateDirectory, 'attempts', attempt.id, 'diagnostics');
  await mkdir(diagnostics);
  await writeFile(join(diagnostics, 'transcript'), 'Diagnostic text');
  const cleanArgs = { attemptId: attempt.id, noProcesses: true, dryRun: true };
  const beforeClean = await snapshot(f.home);
  const cleanPlan = f.invoke('diagnostics.clean', cleanArgs);
  assert.equal(cleanPlan.status, 0, JSON.stringify(cleanPlan.envelope));
  assert.deepEqual(await snapshot(f.home), beforeClean);
  const cleaned = f.invoke('diagnostics.clean', { ...cleanArgs, dryRun: false }, 'clean');
  assert.equal(cleaned.status, 0, JSON.stringify(cleaned.envelope));
  assert.deepEqual(cleaned.data.steps, cleanPlan.data.steps);
  assert.equal(cleaned.data.manifest.entries[0].path, 'transcript');
  await assert.rejects(readdir(diagnostics), { code: 'ENOENT' });
  const replayed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  assert.equal(replayed.data.attempt.id, attempt.id);
  assert.equal(replayed.data.attempt.leaseState, 'returned');
  assert.deepEqual(f.invoke('diagnostics.clean', { ...cleanArgs, dryRun: false }, 'clean').data.manifest, cleaned.data.manifest);
  const records = (await readFile(join(f.home, 'peer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.type === 'prompt').length, 1);
});

test('R09/R32: explicit return rechecks a kept lease after untracked work is retained elsewhere', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const attempt = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }).data.attempt;
  const untracked = join(attempt.allocation.path, 'untracked');
  await writeFile(untracked, 'Keep this work');
  const accepted = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false });
  assert.equal(accepted.data.leaseReturn.state, 'kept');
  await writeFile(join(f.home, 'retained-work'), await readFile(untracked));
  await rm(untracked);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, dryRun: false });
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
});

test('R28/A52: return and discard reject the removed noProcesses field', async t => {
  const f = await fixture(t);
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const [operation, args] of [
    ['attempt.return', { attemptId, dryRun: false }],
    ['attempt.discard', { attemptId, dryRun: false, confirmDiscard: true, reason: 'Not needed' }],
  ] as const) {
    assert.equal(validateSchema(findOperation(operation)!.inputSchema, args), null);
    assert.notEqual(validateSchema(findOperation(operation)!.inputSchema, { ...args, noProcesses: true }), null);
    assert.equal(f.invoke(operation, { ...args, noProcesses: true }).envelope.code, 'invalid_input');
  }
});

test('R11: CLI discards terminal missing/invalid output, refuses dirty work and frees capacity after the exact lease returns', async t => {
  for (const mode of ['missing-result', 'invalid-result']) {
    const f = await fixture(t, mode);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    const failed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
    assert.equal(failed.envelope.code, 'result_invalid');
    const attemptId = failed.data.attemptId;
    assert.ok(attemptId);
    const before = f.invoke('attempt.show', { attemptId }).data;
    assert.equal(before.outcome, 'held'); assert.equal(before.executionOpen, false);
    assert.equal(before.candidate, null);
    assert.equal(before.resultInvalid.message, failed.data.message);
    assert.equal(before.nextAction.operation, 'attempt.continue');
    assert.equal(failed.envelope.nextAction.operation, 'attempt.continue');
    const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
    assert.equal(status.capacity.used, 0);
    assert.equal(status.attempts.items[0].reason, failed.data.message);
    assert.equal(status.attempts.items[0].nextAction.operation, 'attempt.continue');
    const retainedCommit = f.git('rev-parse', before.specification.outputRef).trim();
    assert.equal(retainedCommit.length, 40);
    f.invoke('task.release', { taskId: 'feature' });
    const continuation = f.invoke(before.nextAction.operation, before.nextAction.args);
    assert.equal(continuation.status, 0, JSON.stringify(continuation.envelope));
    assert.equal(continuation.data.startingCommit, retainedCommit);
    const discard = { attemptId, confirmDiscard: true, reason: 'Result is unusable', dryRun: false };
    const dirty = join(before.allocation.path, 'untracked');
    await writeFile(dirty, 'Keep this work');
    const kept = f.invoke('attempt.discard', discard);
    assert.equal(kept.data.leaseReturn.state, 'kept');
    assert.match(kept.data.leaseReturn.reason, /uncommitted or untracked/);
    assert.equal(f.invoke('attempt.show', { attemptId }).data.outcome, 'held');
    await rm(dirty);
    const returned = f.invoke('attempt.return', { attemptId, dryRun: false }, 'return-discarded');
    assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
    assert.equal(returned.data.attempt.outcome, 'held');
    assert.equal(returned.data.attempt.executionOpen, false);
    assert.equal(returned.data.attempt.leaseState, 'returned');
    assert.equal(f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data.capacity.used, 0);
  }
});
