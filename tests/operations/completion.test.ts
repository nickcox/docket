import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { acceptCandidate, returnAttempt, selectCandidate } from '../../src/completion.ts';
import type { CompletionServices } from '../../src/completion.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { runCandidateChecks } from '../../src/checks.ts';
import { Database } from '../../src/storage/database.ts';
import { checkFixture, contextChecks, head, person, policyContent, profile, start } from '../helpers/check-attempt.ts';

async function fixture(t: Parameters<typeof checkFixture>[0], local = false) {
  const f = await checkFixture(t);
  if (local) {
    const config = f.db.events().find(event => event.kind === 'context.configured')!;
    const resolved = structuredClone(config.payload.resolved) as Record<string, any>;
    resolved.finalisation.kind = 'local-merge';
    await f.db.appendEvents([{ sourceKey: 'config:local', kind: 'context.configured', payloadVersion: 1,
      correlationId: 'config:local', actor: person, occurredAt: new Date().toISOString(), payload: { ...config.payload, resolved } }]);
  }
  const a = await f.attempt('task'), candidate = f.db.attempt(a.id).candidate!;
  const activation = f.db.requests().find(request => request.attemptId === a.id && request.operation === 'worker.activate')!;
  await f.db.closePendingEffect(activation.id, 'withdrawn', { reason: 'Synthetic worker is already terminal; no activation will be called' }, person);
  const refs = new Map([['refs/heads/main', start], [a.binding.outputRef, head]]);
  const calls: string[] = [];
  let live = true, clean = true, protection = false, policyReadable = true, retained = true;
  const services: CompletionServices = {
    profile,
    repository: {
      command: async () => { throw new Error('No actual Git in operation tests'); },
      identity: async () => confirmed('/repo'),
      readCheckPolicy: async () => parseCheckPolicy(start, policyContent, contextChecks),
      inspectRef: async ref => confirmed(refs.has(ref) ? { state: 'present', commit: refs.get(ref)! } : { state: 'absent' }),
      inspectWorkspace: async () => confirmed({ branch: a.binding.outputRef, head, clean, uncommitted: clean ? [] : ['dirty'], untracked: [] }),
      compare: async (ancestor, descendant) => confirmed(ancestor === descendant || ancestor === start),
      verifyRetention: async () => retained ? confirmed({ retained: true }) : rejected('Output is not retained'),
      conditionalFastForward: async (ref, expected, commit) => {
        calls.push('integrate');
        if (refs.get(ref) !== expected) return rejected('Target moved');
        refs.set(ref, commit); return confirmed({ ref, commit });
      },
      conditionalDeleteRef: async (ref, expected) => {
        calls.push('cleanup');
        if (refs.get(ref) !== expected) return rejected('Output moved');
        refs.delete(ref); return confirmed({ ref, commit: null });
      },
    },
    run: async check => { calls.push(check.name); return { status: 'passed', exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false }; },
    readPolicy: async () => policyReadable ? confirmed({ digest: 'policy', forbidden: false, protected: protection }) : uncertain('Protection is unreadable'),
    workspace: {
      inspect: async () => confirmed({ state: live ? 'matching' : 'absent' }),
      returnLease: async () => {
        calls.push('return');
        if (!clean) return rejected('Dirty workspace');
        live = false; return confirmed({ returned: true });
      },
    },
  };
  const accept = { requestKey: 'accept', attemptId: a.id, candidateId: String(candidate.id), commit: head, caller: person };
  const returns = { requestKey: 'return', attemptId: a.id, caller: person, noProcesses: { leaseId: a.allocation.leaseId } };
  return { ...f, a, services, refs, calls, accept, returns,
    dirty: () => { clean = false; }, protect: () => { protection = true; }, unreadable: () => { policyReadable = false; },
    loseRetention: () => { retained = false; } };
}

test('R10: acceptance runs fast/full checks once, records the exact candidate and keeps manual output and lease', async t => {
  const f = await fixture(t);
  await acceptCandidate(f.db, f.accept, f.services);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
  assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
  const accepted = f.db.acceptance(f.a.id, f.accept.candidateId)!;
  assert.equal((accepted.payload.candidate as any).commit, head);
  assert.equal(accepted.payload.overrideReason, null);
  await returnAttempt(f.db, f.returns, f.services);
  await returnAttempt(f.db, f.returns, f.services);
  assert.ok(f.refs.has(f.a.binding.outputRef));
  assert.deepEqual(f.calls, ['fast', 'full', 'return']);
});

test('R10: failed and missing checks require a nonblank person reason scoped to the exact candidate', async t => {
  const f = await fixture(t);
  f.services.run = async () => ({ status: 'failed', exitCode: 1, timedOut: false, stdout: '', stderr: 'failure', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /passing checks/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: '  ' }, f.services), /nonblank/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, requestKey: 'override-wrong', commit: start, overrideReason: 'Known failure' }, f.services), /candidate/);
  await acceptCandidate(f.db, { ...f.accept, requestKey: 'override', overrideReason: 'Known unrelated failure' }, f.services);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId)!.payload.overrideReason, 'Known unrelated failure');
  const other = await fixture(t);
  await acceptCandidate(other.db, { ...other.accept, overrideReason: 'Checks unavailable; reviewed by person' }, other.services);
  assert.deepEqual(other.calls, []);
});

test('R10: acceptance reuses an explicit successful retry after the automatic check request failed', async t => {
  const f = await fixture(t), run = f.services.run;
  f.services.run = async () => ({ status: 'failed', exitCode: 1, timedOut: false, stdout: '', stderr: '', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /passing checks/);
  f.services.run = run;
  await runCandidateChecks(f.db, f.a.id, person, f.services, 'explicit-check-retry');
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R10/R11: a check override never waives repository or allocation identity', async t => {
  const f = await fixture(t);
  f.services.repository.identity = async path => confirmed(path === f.a.allocation.path ? '/different-repository' : '/repo');
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: 'Known check failure' }, f.services), /different repository/);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, []);
});

test('R10/R15: changed mandatory policy after checks cannot reuse an old pass for acceptance', async t => {
  const f = await fixture(t), read = f.services.repository.readCheckPolicy;
  let reads = 0;
  f.services.repository.readCheckPolicy = async (...args) => ++reads === 1 ? read(...args) : parseCheckPolicy(start, policyContent + '\n', contextChecks);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /policy changed/);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, ['fast', 'full']);
});

test('R10/R17: non-person callers and changed candidate identity cannot accept, even on replay', async t => {
  const f = await fixture(t);
  await acceptCandidate(f.db, f.accept, f.services);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, caller: { kind: 'supervisor', id: 'model' } as any }, f.services), /person/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, candidateId: 'other' }, f.services), /candidate/);
});

test('R10/R32: local-merge integrates once; a target already containing the candidate needs no mutation', async t => {
  for (const contains of [false, true]) {
    const f = await fixture(t, true);
    if (contains) f.refs.set('refs/heads/main', head);
    await acceptCandidate(f.db, f.accept, f.services);
    await acceptCandidate(f.db, f.accept, f.services);
    assert.equal(f.calls.filter(call => call === 'integrate').length, contains ? 0 : 1);
    assert.equal(f.db.task('task').state, 'done');
    await returnAttempt(f.db, f.returns, f.services);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
    assert.equal(f.refs.has(f.a.binding.outputRef), false);
    assert.equal(f.calls.filter(call => call === 'cleanup').length, 1);
  }
});

test('R10/R32: protected or unreadable target protection refuses local-merge and preserves output', async t => {
  for (const failure of ['protected', 'unknown', 'absent']) {
    const f = await fixture(t, true);
    if (failure === 'protected') f.protect();
    if (failure === 'unknown') f.unreadable();
    if (failure === 'absent') f.refs.delete('refs/heads/main');
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services));
    assert.ok(f.refs.has(f.a.binding.outputRef));
    assert.equal(f.calls.includes('integrate'), false);
    assert.notEqual(f.db.task('task').state, 'done');
  }
});

test('R32: target movement after acceptance planning refuses without moving or deleting output', async t => {
  const f = await fixture(t, true), record = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => {
    const result = await record(...args);
    f.refs.set('refs/heads/main', 'c'.repeat(40));
    return result;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /Target moved/);
  assert.equal(f.calls.includes('integrate'), false);
  assert.ok(f.refs.has(f.a.binding.outputRef));
});

// Each injected crash occurs after the durable step, as if its response was lost.
test('R10/A24: interrupted acceptance resumes every durable step without repeating checks or integration', async t => {
  for (const step of ['recordCommand', 'finishChecks', 'recordAcceptance', 'beginCompletionEffect', 'claimEffect', 'recordEffectOutcome', 'finishAcceptance'] as const) {
    const f = await fixture(t, true);
    const original = (f.db[step] as Function).bind(f.db);
    let interrupted = false;
    (f.db as any)[step] = async (...args: any[]) => {
      const value = await original(...args);
      if (!interrupted) { interrupted = true; throw new Error(`crash:${step}`); }
      return value;
    };
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /crash/);
    if (step === 'claimEffect') {
      // A claimed intent is uncertain, not permission to call. Owner evidence of integration settles it.
      assert.equal(f.calls.includes('integrate'), false);
      await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /unresolved/);
      f.refs.set('refs/heads/main', head);
    }
    const reopened = await Database.open(f.path, f.options); t.after(() => reopened.close());
    await acceptCandidate(reopened, f.accept, f.services);
    await acceptCandidate(reopened, f.accept, f.services);
    assert.equal(reopened.task('task').state, 'done', step);
    assert.equal(f.calls.filter(call => call === 'fast').length, 1, step);
    assert.equal(f.calls.filter(call => call === 'full').length, 1, step);
    assert.equal(f.calls.filter(call => call === 'integrate').length, step === 'claimEffect' ? 0 : 1, step);
  }
});

test('R10/A24: integration performed before a lost response is reconciled, never repeated', async t => {
  const f = await fixture(t, true), integrate = f.services.repository.conditionalFastForward;
  f.services.repository.conditionalFastForward = async (...args) => { await integrate(...args); throw new Error('Lost owner response'); };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /did not succeed/);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.calls.filter(call => call === 'integrate').length, 1);
  assert.equal(f.db.task('task').state, 'done');
});

test('R10: a newer person hold or reopen wins over interrupted acceptance completion', async t => {
  const f = await fixture(t, true), finish = f.db.finishAcceptance.bind(f.db);
  f.db.finishAcceptance = async accepted => { await f.db.holdTask('task', 'Person decision', person); return finish(accepted); };
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.db.task('task').holdReason, 'Person decision');
  assert.notEqual(f.db.task('task').state, 'done');
});

test('R10: a person decision after acceptance but before integration prevents the effect', async t => {
  const f = await fixture(t, true), record = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => { const value = await record(...args); await f.db.holdTask('task', 'Wait', person); return value; };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /newer person/);
  assert.equal(f.calls.includes('integrate'), false);
});

test('R10: a person decision after claiming but immediately before the owner call prevents integration', async t => {
  const f = await fixture(t, true), claim = f.db.claimEffect.bind(f.db);
  f.db.claimEffect = async (...args) => { const result = await claim(...args); await f.db.holdTask('task', 'Stop before owner call', person); return result; };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /did not succeed/);
  assert.equal(f.calls.includes('integrate'), false);
  assert.equal(f.db.task('task').holdReason, 'Stop before owner call');
});

test('R11: return refuses dirty work, missing or wrong confirmations, mismatched allocation and missing retention', async t => {
  for (const failure of ['dirty', 'missing', 'wrong', 'mismatch', 'retention', 'discard']) {
    const f = await fixture(t);
    let input: any = f.returns;
    if (failure === 'dirty') f.dirty();
    if (failure === 'missing') input = { ...input, noProcesses: undefined };
    if (failure === 'wrong') input = { ...input, noProcesses: { leaseId: 'other' } };
    if (failure === 'mismatch') f.services.workspace.inspect = async () => confirmed({ state: 'mismatch' });
    if (failure === 'retention') f.loseRetention();
    if (failure === 'discard') input = { ...input, discard: { leaseId: f.a.allocation.leaseId, confirmed: false } };
    await assert.rejects(returnAttempt(f.db, input, f.services));
    assert.equal(f.calls.includes('return'), false, failure);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
  }
});

test('R11: a non-terminal worker and unresolved check effect refuse return, including with an override', async t => {
  const f = await fixture(t);
  const running = await f.attempt('running', ['Criterion'], undefined, head, start, policyContent, 'validated');
  await assert.rejects(returnAttempt(f.db, { ...f.returns, requestKey: 'running-return', attemptId: running.id,
    noProcesses: { leaseId: running.allocation.leaseId } }, f.services), /stopped terminal/);
  f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services), /unresolved effect/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, requestKey: 'override', overrideReason: 'Accept failure' }, f.services), /unresolved effect/);
});

test('R11: discard returns once, holds unfinished work and preserves a newer done decision', async t => {
  for (const done of [false, true]) {
    const f = await fixture(t);
    if (done) await f.db.markTaskDone('task', person);
    const input = { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true as const, reason: 'Output is no longer needed' } };
    await returnAttempt(f.db, input, f.services);
    await returnAttempt(f.db, input, f.services);
    assert.equal(f.db.task('task').state, done ? 'done' : 'queued');
    assert.equal(f.db.task('task').holdReason, done ? 'awaiting_acceptance' : 'discarded');
    assert.deepEqual(f.calls, ['return', 'cleanup']);
  }
});

test('R11: lost return response reconciles from the matching pool and never repeats return', async t => {
  const f = await fixture(t), original = f.services.workspace.returnLease;
  f.services.workspace.returnLease = async (...args) => { await original(...args); throw new Error('Lost return response'); };
  await assert.rejects(returnAttempt(f.db, f.returns, f.services));
  await returnAttempt(f.db, f.returns, f.services);
  assert.deepEqual(f.calls, ['return']);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('R11: moved refs, failed cleanup and unknown cleanup never reverse a confirmed return', async t => {
  for (const failure of ['moved', 'rejected', 'uncertain']) {
    const f = await fixture(t, true);
    await acceptCandidate(f.db, f.accept, f.services);
    if (failure === 'moved') f.refs.set(f.a.binding.outputRef, 'c'.repeat(40));
    else f.services.repository.conditionalDeleteRef = async () => failure === 'rejected' ? rejected('Checked out elsewhere') : uncertain('Lost delete response');
    await returnAttempt(f.db, f.returns, f.services);
    assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
    assert.ok(f.refs.has(f.a.binding.outputRef));
    await returnAttempt(f.db, f.returns, f.services);
    assert.ok(f.refs.has(f.a.binding.outputRef));
  }
});

test('R11: changed validated output refuses acceptance and return, even with a check override', async t => {
  const f = await fixture(t);
  await writeFile(f.a.binding.resultPath, '{}');
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, overrideReason: 'Ignore checks' }, f.services));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services));
  assert.deepEqual(f.calls, []);
});

test('R10/A24: unknown owner reads before and after integration intent retry without another check or effect', async t => {
  for (const failAt of [1, 2]) {
    const f = await fixture(t, true), read = f.services.readPolicy!;
    let reads = 0;
    f.services.readPolicy = async (...args) => ++reads === failAt ? uncertain('Owner read failed') : read(...args);
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /Owner read failed/);
    await acceptCandidate(f.db, f.accept, f.services);
    assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
    assert.equal(f.db.task('task').state, 'done');
  }
});

test('R10/A24: concurrent acceptance inspects claimed integration and cannot call it again', async t => {
  const f = await fixture(t, true), integrate = f.services.repository.conditionalFastForward;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  f.services.repository.conditionalFastForward = async (...args) => { entered(); await ready; return integrate(...args); };
  const first = acceptCandidate(f.db, f.accept, f.services);
  await waiting;
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /unresolved/);
  release(); await first;
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
});

test('R11/A24: return resumes after each durable step and never repeats the lease effect', async t => {
  for (const step of ['recordCommand', 'authoriseReturn', 'beginCompletionEffect', 'recordEffectOutcome', 'finishReturn'] as const) {
    const f = await fixture(t), original = (f.db[step] as Function).bind(f.db);
    let interrupted = false;
    (f.db as any)[step] = async (...args: any[]) => {
      const value = await original(...args);
      if (!interrupted) { interrupted = true; throw new Error(`crash:${step}`); }
      return value;
    };
    await assert.rejects(returnAttempt(f.db, f.returns, f.services), /crash/);
    const reopened = await Database.open(f.path, f.options); t.after(() => reopened.close());
    await returnAttempt(reopened, f.returns, f.services);
    await returnAttempt(reopened, f.returns, f.services);
    assert.equal(reopened.attempt(f.a.id).leaseState, 'returned');
    assert.deepEqual(f.calls, ['return']);
  }
});

test('R11: a recreated output ref is not deleted again after successful cleanup', async t => {
  const f = await fixture(t, true);
  await acceptCandidate(f.db, f.accept, f.services);
  await returnAttempt(f.db, f.returns, f.services);
  f.refs.set(f.a.binding.outputRef, head);
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.refs.get(f.a.binding.outputRef), head);
  assert.equal(f.calls.filter(call => call === 'cleanup').length, 1);
});

test('R10/R11/R25: task completion and returned state roll back with failed explanatory events', async t => {
  for (const kind of ['acceptance.finished', 'lease.returned']) {
    for (const after of [false, true]) {
      const f = await fixture(t, true), target = f.db as any, original = target.insertEvent;
      let failed = false;
      target.insertEvent = function (event: any) {
        if (!failed && event.kind === kind) {
          failed = true;
          if (after) original.call(this, event);
          throw new Error('Injected event failure');
        }
        return original.call(this, event);
      };
      if (kind === 'acceptance.finished') {
        await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /Injected/);
        assert.notEqual(f.db.task('task').state, 'done');
        await acceptCandidate(f.db, f.accept, f.services);
        assert.equal(f.db.task('task').state, 'done');
        assert.equal(f.calls.filter(call => call === 'integrate').length, 1);
      } else {
        await assert.rejects(returnAttempt(f.db, f.returns, f.services), /Injected/);
        assert.equal(f.db.attempt(f.a.id).leaseState, 'held');
        await returnAttempt(f.db, f.returns, f.services);
        assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
        assert.deepEqual(f.calls, ['return']);
      }
      assert.equal(f.db.events().filter(event => event.kind === kind).length, 1);
    }
  }
});

test('R11: explicit retained branch selection creates a fresh exact candidate and requires fresh checks', async t => {
  const f = await fixture(t), commit = 'c'.repeat(40);
  f.refs.set(f.a.binding.outputRef, commit);
  await selectCandidate(f.db, { attemptId: f.a.id, commit, caller: person }, f.services);
  const selected = f.db.attempt(f.a.id).candidate!;
  assert.notEqual(selected.id, f.accept.candidateId);
  assert.equal(selected.commit, commit);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /candidate/);
  await assert.rejects(selectCandidate(f.db, { attemptId: f.a.id, commit: head, caller: person }, f.services), /exact candidate/);
});
