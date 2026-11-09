import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { acceptCandidate, returnAttempt, selectCandidate, planCandidateAcceptance, planAttemptReturn, automaticReturn, leaseReturnReason } from '../../src/completion.ts';
import { rebaseAttempt, planAttemptRebase } from '../../src/rebase.ts';
import { originalCandidateRef } from '../../src/storage/rebase.ts';
import type { CompletionServices } from '../../src/completion.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { mandatoryChecks, parseCheckPolicy } from '../../src/check-policy.ts';
import type { TrustedChecks } from '../../src/storage/reservations.ts';
import { runCandidateChecks } from '../../src/checks.ts';
import { Database } from '../../src/storage/database.ts';
import { CommandFailure } from '../../src/response.ts';
import { checkFixture, contextChecks, head, host, person, policyContent, profile, start } from '../helpers/check-attempt.ts';

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
      createPinnedRef: async () => { throw new Error('Rebase not configured'); },
      conditionalMoveRef: async () => { throw new Error('Rebase not configured'); },
      prepareRebase: async () => { throw new Error('Rebase not configured'); },
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
  const returns = { requestKey: 'return', attemptId: a.id, caller: person };
  return { ...f, a, services, refs, calls, accept, returns,
    dirty: () => { clean = false; }, cleanWorkspace: () => { clean = true; }, protect: () => { protection = true; }, unreadable: () => { policyReadable = false; },
    loseRetention: () => { retained = false; } };
}

test('R11: person discards terminal missing/invalid results without retention and frees execution capacity', async t => {
  for (const invalid of [false, true]) {
    const f = await fixture(t);
    const a = await f.attempt(`missing-${invalid}`, ['Criterion'], undefined, head, start, policyContent, 'prepared');
    const activation = f.db.requests().find(r => r.attemptId === a.id && r.operation === 'worker.activate')!;
    await f.db.closePendingEffect(activation.id, 'withdrawn', { reason: 'No activation in fixture' }, person);
    if (invalid) await writeFile(a.binding.resultPath, 'invalid');
    else await unlink(a.binding.resultPath);
    const input = { requestKey: `discard-${invalid}`, attemptId: a.id, caller: person,
      discard: { leaseId: a.allocation.leaseId, confirmed: true as const, reason: 'Result unavailable' } };
    await assert.rejects(returnAttempt(f.db, input, f.services), /terminal/);
    await f.db.recordWorkerObservation(a.observation('terminal', 2), host);
    f.dirty();
    await assert.rejects(returnAttempt(f.db, input, f.services), /uncommitted/);
    assert.equal(f.db.attempt(a.id).outcome, 'failed', 'discard settles the outcome but keeps dirty work');
    assert.equal(f.db.attempt(a.id).leaseState, 'held');
    f.cleanWorkspace();
    f.services.repository.verifyRetention = async () => { throw new Error('Must not require retained output'); };
    await returnAttempt(f.db, input, f.services);
    await returnAttempt(f.db, input, f.services);
    assert.equal(f.db.attempt(a.id).outcome, 'failed');
    assert.equal(f.db.attempt(a.id).executionOpen, false);
    assert.equal(f.db.attempt(a.id).leaseState, 'returned');
    assert.equal(f.db.task(a.binding.identity.taskId as string).holdReason, 'discarded');
    assert.equal(f.db.events().filter(e => e.sourceKey === `attempt.discard_failed:${a.id}`).length, 1);
  }
});

test('A21/R11: automatic return records its origin, cleans integrated refs and keeps manual output', async t => {
  for (const local of [true, false]) {
    const f = await fixture(t, local);
    await acceptCandidate(f.db, f.accept, f.services);
    const returned = await automaticReturn(f.db, f.a.id, person, f.services);
    assert.equal(returned.state, 'returned');
    assert.equal(returned.attempt.leaseState, 'returned');
    assert.equal(f.refs.has(f.a.binding.outputRef), !local);
    const event = f.db.events().find(e => e.kind === 'return.authorised')!;
    assert.equal(event.payload.automatic, true);
    assert.equal('noProcesses' in event.payload, false);
    assert.equal((await automaticReturn(f.db, f.a.id, person, f.services)).state, 'returned');
    assert.equal(f.calls.filter(call => call === 'return').length, 1);
  }
});

test('A21/R11: automatic return keeps dirty, unretained, mismatched and unresolved work with current reasons', async t => {
  for (const failure of ['dirty', 'retention', 'allocation', 'effect']) {
    const f = await fixture(t);
    await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Independently verified' }, f.services);
    if (failure === 'dirty') f.dirty();
    if (failure === 'retention') f.loseRetention();
    if (failure === 'allocation') f.services.workspace.inspect = async () => confirmed({ state: 'mismatch' });
    if (failure === 'effect') {
      f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
      await runCandidateChecks(f.db, f.a.id, person, f.services, 'uncertain-check');
    }
    const kept = await automaticReturn(f.db, f.a.id, person, f.services);
    assert.equal(kept.state, 'kept', failure);
    assert.equal(kept.attempt.leaseState, 'held');
    assert.match(kept.reason!, /uncommitted|retained|match|unresolved/);
    assert.equal(await leaseReturnReason(f.db, f.a.id, person, f.services), kept.reason);
    assert.equal(f.calls.includes('return'), false);
  }
});

test('R11: discard records the person decision before keeping dirt, then explicit return needs no retained output', async t => {
  const f = await fixture(t);
  f.dirty(); f.loseRetention();
  const discard = { leaseId: f.a.allocation.leaseId, confirmed: true as const, reason: 'No longer needed' };
  const kept = await automaticReturn(f.db, f.a.id, person, f.services, discard, 'person-discard');
  assert.equal(kept.state, 'kept');
  assert.equal(f.db.task('task').holdReason, 'discarded');
  const authorisation = f.db.events().find(e => e.kind === 'return.authorised')!;
  assert.equal(authorisation.payload.automatic, false);
  assert.equal(authorisation.payload.discardReason, discard.reason);
  f.cleanWorkspace();
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.db.attempt(f.a.id).leaseState, 'returned');
});

test('R11: discard keeps an unresolved effect without losing the person decision', async t => {
  const f = await fixture(t);
  f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
  await runCandidateChecks(f.db, f.a.id, person, f.services, 'uncertain-before-discard');
  const kept = await automaticReturn(f.db, f.a.id, person, f.services,
    { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'Stop work on this task' }, 'discard-unresolved');
  assert.equal(kept.state, 'kept');
  assert.match(kept.reason!, /unresolved effect/);
  assert.equal(f.db.task('task').holdReason, 'discarded');
  assert.equal(f.calls.includes('return'), false);
});

test('R11: an invalid discard is refused rather than reported as a successful decision with a kept lease', async t => {
  const f = await fixture(t);
  const running = await f.attempt('running-discard', ['Criterion'], undefined, head, start, policyContent, 'validated');
  await assert.rejects(automaticReturn(f.db, running.id, person, f.services,
    { leaseId: running.allocation.leaseId, confirmed: true, reason: 'Not stopped' }, 'invalid-discard'), /terminal/);
  assert.equal(f.db.events().some(e => e.attemptId === running.id && e.kind === 'return.authorised'), false);
});

test('R30: acceptance plans missing checks and conditional acceptance without writes; execution runs those checks', async t => {
  const f = await fixture(t, true);
  const events = f.db.events(), requests = f.db.requests(), claims = f.db.claims();
  const plan = await planCandidateAcceptance(f.db, f.accept, f.services);
  assert.deepEqual(plan.steps.map(s => s.operation), ['checks.run', 'candidate.accept', 'repository.integrate', 'task.complete']);
  assert.equal(plan.steps[1]!.conditional, true);
  assert.deepEqual(f.db.events(), events); assert.deepEqual(f.db.requests(), requests); assert.deepEqual(f.db.claims(), claims);
  assert.deepEqual(f.calls, []);
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full', 'integrate']);
  assert.deepEqual((await planCandidateAcceptance(f.db, f.accept, f.services)).steps, []);
  const returnPlan = await planAttemptReturn(f.db, f.returns, f.services);
  assert.deepEqual(returnPlan.steps.map(s => s.target), [f.a.allocation.leaseId]);
});

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
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'check_failed' });
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), { code: 'check_failed' });
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
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), { code: 'check_failed' });
  f.services.run = run;
  await runCandidateChecks(f.db, f.a.id, person, f.services, 'explicit-check-retry');
  await acceptCandidate(f.db, f.accept, f.services);
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R16/R27: acceptance names waiting checks and their slot holder, then retries the pending run and accepts', async t => {
  const f = await fixture(t), other = await f.attempt('slot-holder', ['Other criterion']);
  const checks = mandatoryChecks(f.db.attempt(other.id).specification.checks as TrustedChecks,
    parseCheckPolicy(start, policyContent, contextChecks));
  const holder = await f.db.beginChecks({ attemptId: other.id, commit: head, checks, profile, caller: person });
  const assertWaiting = (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'checks_waiting');
    const waiting = f.db.requests().find(r => r.attemptId === f.a.id && r.operation === 'checks.run')!;
    assert.deepEqual(error.data.checkRequest, { id: waiting.id, requestId: waiting.requestKey,
      state: 'pending', status: null, evidenceKey: waiting.input.evidenceKey });
    assert.deepEqual(error.data.slotHolders, [{ claimId: holder.executor!.claimId, attemptId: other.id,
      ownerRef: person, checkRequestId: holder.request.id, requestId: holder.request.requestKey, state: 'claimed' }]);
    assert.equal(error.nextAction?.operation, 'attempt.accept');
    assert.deepEqual(error.nextAction?.args, { attemptId: f.a.id, candidateCommit: head, overrideReason: null, dryRun: false });
    return true;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), assertWaiting);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), assertWaiting);
  assert.equal(f.db.attempt(f.a.id).phase, 'awaiting_checks');
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.deepEqual(f.calls, []);
  assert.ok((await planCandidateAcceptance(f.db, f.accept, f.services)).steps.some(s => s.operation === 'checks.run'));
  const waiting = f.db.requests().find(r => r.attemptId === f.a.id && r.operation === 'checks.run')!;
  await f.db.finishChecks(holder.request.id, holder.executor!, { status: 'failed',
    evidenceKey: String(holder.request.input.evidenceKey), commands: [] });
  await acceptCandidate(f.db, f.accept, f.services);
  assert.equal(f.db.request(waiting.id).state, 'succeeded');
  assert.deepEqual(f.calls, ['fast', 'full']);
  assert.equal(f.db.task('task').state, 'done');
});

test('R16/R27: claimed and uncertain checks report their actual state in acceptance and planning', async t => {
  for (const state of ['claimed', 'uncertain'] as const) {
    const f = await fixture(t);
    const admission = await f.db.beginChecks({ attemptId: f.a.id, commit: head,
      checks: mandatoryChecks(f.db.attempt(f.a.id).specification.checks as TrustedChecks,
        parseCheckPolicy(start, policyContent, contextChecks)), profile, caller: person });
    if (state === 'uncertain') await f.db.finishChecks(admission.request.id, admission.executor!, {
      status: 'uncertain', evidenceKey: String(admission.request.input.evidenceKey), commands: [] });
    const inspect = (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.code, state === 'claimed' ? 'checks_waiting' : 'effect_uncertain');
      assert.equal((error.data.checkRequest as any).state, state);
      assert.equal((error.data.checkRequest as any).requestId, admission.request.requestKey);
      return true;
    };
    await assert.rejects(acceptCandidate(f.db, f.accept, f.services), inspect);
    await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), inspect);
    assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
    assert.deepEqual(f.calls, []);
  }
});

test('R10: a person can override checks waiting for a slot without leaving an authorised check behind', async t => {
  const f = await fixture(t, true), other = await f.attempt('other');
  const checks = parseCheckPolicy(start, policyContent, contextChecks);
  await f.db.beginChecks({ attemptId: other.id, commit: head, checks, profile, caller: person });
  const waiting = await f.db.beginChecks({ attemptId: f.a.id, commit: head, checks, profile, caller: person });
  assert.equal(waiting.request.state, 'pending');
  await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Person has independently verified the output' }, f.services);
  assert.equal(f.db.request(waiting.request.id).state, 'withdrawn');
  assert.deepEqual(f.calls, ['integrate']);
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

test('R27/R30: a divergent target refuses planning and execution with exact commits and a rebase action', async t => {
  const f = await fixture(t, true), moved = 'c'.repeat(40);
  f.refs.set('refs/heads/main', moved);
  const events = f.db.events(), requests = f.db.requests();
  const refusal = (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'not_fast_forward');
    assert.deepEqual(error.data, { attemptId: f.a.id, targetRef: 'refs/heads/main', targetCommit: moved, candidateCommit: head });
    assert.deepEqual(error.nextAction?.args, { attemptId: f.a.id, dryRun: true });
    assert.equal(error.nextAction?.operation, 'attempt.rebase');
    return true;
  };
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), refusal);
  assert.deepEqual(f.db.events(), events);
  assert.deepEqual(f.db.requests(), requests);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), refusal);
  assert.equal(f.db.acceptance(f.a.id, f.accept.candidateId), null);
  assert.equal(f.calls.includes('integrate'), false);
  assert.ok(f.refs.has(f.a.binding.outputRef));
});

test('R27/R32: target movement after acceptance planning refuses without moving or deleting output', async t => {
  const f = await fixture(t, true), record = f.db.recordAcceptance.bind(f.db);
  f.db.recordAcceptance = async (...args) => {
    const result = await record(...args);
    f.refs.set('refs/heads/main', 'c'.repeat(40));
    return result;
  };
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'not_fast_forward');
    assert.equal(error.data.targetCommit, 'c'.repeat(40));
    return true;
  });
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
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
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

test('R11: return refuses dirty work, mismatched allocation, missing retention and invalid discard confirmation', async t => {
  for (const failure of ['dirty', 'mismatch', 'retention', 'discard']) {
    const f = await fixture(t);
    let input: any = f.returns;
    if (failure === 'dirty') f.dirty();
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
    }, f.services), /stopped terminal/);
  f.services.run = async () => ({ status: 'uncertain', exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false });
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services));
  await assert.rejects(returnAttempt(f.db, f.returns, f.services), /unresolved effect/);
  await assert.rejects(acceptCandidate(f.db, { ...f.accept, requestKey: 'override', overrideReason: 'Accept failure' }, f.services), /unresolved effect/);
});

test('R03/R11: discard returns once, holds unfinished work and preserves a newer done decision', async t => {
  for (const done of [false, true]) {
    const f = await fixture(t);
    if (done) await f.db.markTaskDone('task', person);
    const input = { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true as const, reason: 'Output is no longer needed' } };
    await returnAttempt(f.db, input, f.services);
    await returnAttempt(f.db, input, f.services);
    assert.equal(f.db.task('task').state, done ? 'done' : 'queued');
    assert.equal(f.db.task('task').holdReason, done ? null : 'discarded');
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
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
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
  f.services.repository.inspectWorkspace = async () => confirmed({ branch: f.a.binding.outputRef, head: commit, clean: true, uncommitted: [], untracked: [] });
  const beforeSelection = f.db.attempt(f.a.id);
  const plan = await planCandidateAcceptance(f.db, { ...f.accept, candidateId: 'planned-selection', commit }, f.services, true);
  assert.equal(plan.steps[0]!.operation, 'candidate.select');
  assert.deepEqual(f.db.attempt(f.a.id), beforeSelection);
  await selectCandidate(f.db, { attemptId: f.a.id, commit, caller: person }, f.services);
  const selected = f.db.attempt(f.a.id).candidate!;
  assert.notEqual(selected.id, f.accept.candidateId);
  assert.equal(selected.commit, commit);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /candidate/);
  await assert.rejects(selectCandidate(f.db, { attemptId: f.a.id, commit: head, caller: person }, f.services), /exact candidate/);
});

async function rebaseFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t, true);
  let state = { branch: f.a.binding.outputRef as string | null, head, clean: true, uncommitted: [] as string[], untracked: [] as string[] };
  let merge = false, conflict = false, abortUnknown = false;
  const target = 'c'.repeat(40), rebased = 'd'.repeat(40), second = 'e'.repeat(40);
  f.refs.set('refs/heads/main', target);
  const repository = f.services.repository;
  repository.inspectWorkspace = async () => confirmed(state);
  repository.compare = async (ancestor, descendant) => confirmed(ancestor === descendant || ancestor === start || (ancestor === target && descendant === rebased));
  repository.command = async args => {
    if (args[0] === 'switch') { f.calls.push('attach'); state.branch = f.a.binding.outputRef; }
    return { complete: true, code: 0, stdout: args[0] === 'merge-base' ? start + '\n' : args[0] === 'rev-list' && merge ? head + '\n' : '', stderr: '' };
  };
  repository.createPinnedRef = async (ref, commit) => { f.calls.push('pin'); if (f.refs.has(ref)) return rejected('Exists'); f.refs.set(ref, commit); return confirmed({ ref, commit }); };
  repository.prepareRebase = async (_workspace, original, upstream, onto) => {
    f.calls.push('rebase'); assert.equal(upstream, original === head ? start : target); assert.equal(onto, f.refs.get('refs/heads/main'));
    if (abortUnknown) return uncertain('Abort unknown');
    if (conflict) return rejected('rebase_conflict');
    state = { ...state, branch: null, head: original === head ? rebased : second };
    return confirmed({ commit: state.head });
  };
  repository.conditionalMoveRef = async (ref, expected, commit) => {
    f.calls.push('move'); assert.equal(state.branch, null);
    if (f.refs.get(ref) !== expected) return rejected('Moved');
    f.refs.set(ref, commit); return confirmed({ ref, commit });
  };
  repository.verifyRetention = async request => {
    for (const reference of request.references) {
      const retained = f.refs.get(reference.ref);
      if (!retained || !knownState(await repository.compare(reference.commit, retained))) return rejected('Output is not retained');
    }
    return confirmed({ retained: true });
  };
  return { ...f, target, rebased, second, input: { requestKey: 'rebase', attemptId: f.a.id, caller: person },
    changeState: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; },
    merges: () => { merge = true; }, conflict: () => { conflict = true; }, abortUnknown: () => { abortUnknown = true; } };
}

test('A25/R14/R09/R30: rebase retains original, records new candidate, replays once and accepts with fresh checks', async t => {
  const f = await rebaseFixture(t);
  await assert.rejects(planCandidateAcceptance(f.db, f.accept, f.services), (e: any) => e.code === 'not_fast_forward');
  const before = [f.db.events(), f.db.requests(), f.db.claims()];
  const plan = await planAttemptRebase(f.db, f.input, f.services);
  assert.deepEqual(plan.steps.map(s => s.operation), ['rebase.pin', 'rebase.rebase', 'rebase.move', 'rebase.attach', 'candidate.record']);
  assert.deepEqual([f.db.events(), f.db.requests(), f.db.claims()], before);
  await rebaseAttempt(f.db, f.input, f.services);
  const candidate = f.db.attempt(f.a.id).candidate!;
  assert.notEqual(candidate.id, f.accept.candidateId); assert.equal(candidate.commit, f.rebased);
  assert.deepEqual(f.calls, ['pin', 'rebase', 'move', 'attach']);
  await rebaseAttempt(f.db, f.input, f.services);
  assert.deepEqual((await planAttemptRebase(f.db, f.input, f.services)).steps, []);
  assert.deepEqual(f.calls, ['pin', 'rebase', 'move', 'attach']);
  const event = f.db.events().find(e => e.kind === 'output.rebased')!;
  assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased], [head, start, f.target, f.rebased]);
  assert.equal(f.refs.get(originalCandidateRef(f.db.attempt(f.a.id).specification)), head);
  await assert.rejects(acceptCandidate(f.db, f.accept, f.services), /candidate/);
  await acceptCandidate(f.db, { ...f.accept, candidateId: String(candidate.id), commit: String(candidate.commit) }, f.services);
  assert.ok(f.calls.includes('fast') && f.calls.includes('full'));
  await returnAttempt(f.db, f.returns, f.services);
  assert.equal(f.refs.has(originalCandidateRef(f.db.attempt(f.a.id).specification)), false);
  assert.equal(f.refs.has(f.a.binding.outputRef), false);
});

test('A25: dirty, moved, merge and accepted candidates refuse before any rebase effect', async t => {
  for (const scenario of ['dirty', 'moved', 'merge', 'accepted']) {
    const f = await rebaseFixture(t);
    if (scenario === 'dirty') f.changeState({ clean: false });
    if (scenario === 'moved') f.refs.set(f.a.binding.outputRef, f.rebased);
    if (scenario === 'merge') f.merges();
    if (scenario === 'accepted') {
      f.refs.set('refs/heads/main', start);
      await acceptCandidate(f.db, { ...f.accept, overrideReason: 'Person checked' }, f.services);
      f.calls.length = 0;
    }
    const refs = [...f.refs];
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services));
    assert.deepEqual(f.calls, []); assert.deepEqual([...f.refs], refs);
  }
});

test('A25/R09: conflict is a stable refusal; an unconfirmed abort stays uncertain and is not repeated', async t => {
  for (const unknown of [false, true]) {
    const f = await rebaseFixture(t);
    if (unknown) f.abortUnknown(); else f.conflict();
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services), unknown ? /did not succeed/ : (e: any) => e.code === 'rebase_conflict');
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services));
    assert.equal(f.calls.filter(c => c === 'rebase').length, 1);
    assert.equal(f.refs.get(f.a.binding.outputRef), head);
    const state = knownState(await f.services.repository.inspectWorkspace(f.a.allocation.path));
    assert.equal(state.branch, f.a.binding.outputRef); assert.equal(state.head, head);
    assert.equal(f.db.requests().find(r => r.operation === 'completion.rebase')!.state, unknown ? 'uncertain' : 'rejected');
  }
});
function knownState<T>(result: import('../../src/adapters/command.ts').Result<T>): T {
  assert.equal(result.status, 'confirmed'); return (result as { value: T }).value;
}

test('R14/R11: target moving again permits another rebase; discard keeps a moved pin and reports it', async t => {
  const f = await rebaseFixture(t);
  await rebaseAttempt(f.db, f.input, f.services);
  const first = f.db.attempt(f.a.id).candidate!;
  f.refs.set('refs/heads/main', 'f'.repeat(40));
  await assert.rejects(planCandidateAcceptance(f.db, { ...f.accept, candidateId: String(first.id), commit: String(first.commit) }, f.services), (e: any) => e.code === 'not_fast_forward');
  const compareBefore = f.services.repository.compare, commandBefore = f.services.repository.command;
  const comparisons: string[][] = [], ranges: string[] = [];
  f.services.repository.compare = async (ancestor, descendant) => {
    comparisons.push([ancestor, descendant]);
    return compareBefore(ancestor, descendant);
  };
  f.services.repository.command = async (args, cwd) => {
    if (args[0] === 'rev-list') ranges.push(args[2]!);
    return commandBefore(args, cwd);
  };
  const secondInput = { ...f.input, requestKey: 'second' };
  await planAttemptRebase(f.db, secondInput, f.services);
  assert.ok(comparisons.some(([ancestor, descendant]) => ancestor === f.target && descendant === f.rebased));
  assert.deepEqual(ranges, [`${f.target}..${f.rebased}`]);
  ranges.length = 0;
  await rebaseAttempt(f.db, secondInput, f.services);
  assert.ok(ranges.length > 0 && ranges.every(range => range === `${f.target}..${f.rebased}`));
  assert.equal(f.db.attempt(f.a.id).candidate!.commit, f.second);
  const event = f.db.events().findLast(e => e.kind === 'output.rebased')!;
  assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased],
    [f.rebased, f.target, 'f'.repeat(40), f.second]);
  const pin = originalCandidateRef(f.db.attempt(f.a.id).specification);
  f.refs.set(pin, f.target);
  // A moved pin may still retain the original as an ancestor, but cleanup must not delete it.
  const compare = f.services.repository.compare;
  f.services.repository.compare = async (ancestor, descendant) => ancestor === head && descendant === f.target
    ? confirmed(true) : compare(ancestor, descendant);
  await returnAttempt(f.db, { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'Discard rebased work' } }, f.services);
  assert.equal(f.refs.get(pin), f.target);
  assert.equal(f.db.requests().find(r => r.operation === 'completion.cleanup-pin')!.state, 'rejected');
});

test('R09: interrupted rebase resumes durable steps and never replays a successful detached rebase', async t => {
  for (const stage of ['pin', 'rebase', 'move', 'attach']) {
    const f = await rebaseFixture(t);
    const original = f.db.recordEffectOutcome.bind(f.db);
    let interrupted = false;
    f.db.recordEffectOutcome = async (...args) => {
      const request = await original(...args);
      if (!interrupted && request.operation === `completion.${stage}`) { interrupted = true; throw new Error('Lost durable response'); }
      return request;
    };
    await assert.rejects(rebaseAttempt(f.db, f.input, f.services), /Lost durable response/);
    const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
    await planAttemptRebase(reopened, f.input, f.services);
    await rebaseAttempt(reopened, f.input, f.services);
    assert.equal(reopened.attempt(f.a.id).candidate!.commit, f.rebased);
    assert.equal(f.calls.filter(call => call === 'rebase').length, 1);
  }
});

test('R09: lost conditional move response reconciles from the output owner, without repeating rebase or move', async t => {
  const f = await rebaseFixture(t), move = f.services.repository.conditionalMoveRef;
  f.services.repository.conditionalMoveRef = async (...args) => { await move(...args); throw new Error('Lost move response'); };
  await assert.rejects(rebaseAttempt(f.db, f.input, f.services), /did not succeed/);
  await planAttemptRebase(f.db, f.input, f.services);
  await rebaseAttempt(f.db, f.input, f.services);
  assert.equal(f.db.attempt(f.a.id).candidate!.commit, f.rebased);
  assert.equal(f.calls.filter(call => call === 'rebase').length, 1);
  assert.equal(f.calls.filter(call => call === 'move').length, 1);
});

test('R11/R14: discarding a rebased candidate deletes the exact original pin after return', async t => {
  const f = await rebaseFixture(t);
  await rebaseAttempt(f.db, f.input, f.services);
  await returnAttempt(f.db, { ...f.returns, discard: { leaseId: f.a.allocation.leaseId, confirmed: true, reason: 'No longer needed' } }, f.services);
  assert.equal(f.refs.has(originalCandidateRef(f.db.attempt(f.a.id).specification)), false);
  assert.equal(f.calls.indexOf('return') < f.calls.indexOf('cleanup'), true);
});
