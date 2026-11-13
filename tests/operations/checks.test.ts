import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { heartbeatStatus } from '../../src/storage/claims.ts';
import { confirmed, uncertain } from '../../src/adapters/command.ts';
import type { CheckCommandResult } from '../../src/adapters/checks.ts';
import { mandatoryChecks, parseCheckPolicy } from '../../src/check-policy.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { executeCoreOperation } from '../../src/operations.ts';
import { requestView } from '../../src/request-view.ts';
import { acceptanceCheckFailure } from '../../src/storage/checks.ts';
import { runCandidateChecks, runChecks } from '../../src/checks.ts';
import { CommandFailure } from '../../src/response.ts';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';
import type { CheckServices } from '../../src/checks.ts';
import { Database } from '../../src/storage/database.ts';
import { reserveWithTrustedChecks } from '../../src/attempts.ts';
import { observeWorker } from '../../src/workers.ts';
import { checkFixture, contextChecks, head, host, person, policyContent, profile, retention, start } from '../helpers/check-attempt.ts';

const passed: CheckCommandResult = { status: 'passed', exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false };
function fakeServices() {
  const calls: string[] = [];
  let content: string | null = policyContent, sourceCommit = start, clean = true, candidate = head;
  const services: CheckServices = { profile,
    repository: { readCheckPolicy: async () => parseCheckPolicy(sourceCommit, content, contextChecks),
      identity: async () => confirmed('/repo'),
      inspectRef: async () => confirmed({ state: 'present', commit: candidate }),
      inspectWorkspace: async () => confirmed({ branch: 'refs/heads/worker', head: candidate, clean, uncommitted: clean ? [] : ['file'], untracked: [] }) },
    run: async check => { calls.push(check.name); return passed; } };
  return { services, calls, policy: (value: string | null) => { content = value; }, source: (value: string) => { sourceCommit = value; },
    dirty: () => { clean = false; }, move: () => { candidate = start; } };
}

test('R28/R30/R15/R16/A35: checks.run plans without writes, retries failures explicitly and reuses passing evidence', async t => {
  const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
  const input = { attemptId: a.id, commit: head, dryRun: false };
  const operation = findOperation('checks.run')!;
  assert.deepEqual(operation.roles, ['person', 'supervisor']);
  assert.equal(operation.plans, true);
  assert.equal(validateSchema(operation.inputSchema, input), null);
  assert.notEqual(validateSchema(operation.inputSchema, { ...input, commit: 'bad' }), null);
  const before = { events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() };
  const plan = await runChecks(f.db, { ...input, dryRun: true }, person, 'explicit', fake.services);
  assert.deepEqual(plan.steps.map(step => step.operation), ['checks.run']);
  assert.deepEqual({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() }, before);
  assert.deepEqual(fake.calls, []);
  fake.services.run = async check => { fake.calls.push(check.name); return { ...passed, status: 'failed', exitCode: 1 }; };
  await assert.rejects(runChecks(f.db, input, person, 'explicit', fake.services), (error: unknown) =>
    error instanceof CommandFailure && error.code === 'check_failed' && error.nextAction?.operation === 'checks.run');
  const read = fake.services.repository.readCheckPolicy;
  fake.services.repository.readCheckPolicy = async () => { throw new Error('Replay must not read policy'); };
  await assert.rejects(runChecks(f.db, input, person, 'explicit', fake.services), (error: unknown) =>
    error instanceof CommandFailure && error.code === 'check_failed');
  await assert.rejects(runChecks(f.db, { ...input, dryRun: true }, person, 'explicit', fake.services), (error: unknown) =>
    error instanceof CommandFailure && error.code === 'check_failed');
  await assert.rejects(runChecks(f.db, { ...input, commit: start }, person, 'explicit', fake.services), (error: unknown) =>
    error instanceof CommandFailure && error.code === 'request_input_mismatch');
  assert.deepEqual(fake.calls, ['fast']);
  fake.services.repository.readCheckPolicy = read;
  fake.services.run = async check => { fake.calls.push(check.name); return passed; };
  const retry = await runChecks(f.db, input, person, 'retry', fake.services);
  assert.deepEqual(retry.steps, plan.steps);
  assert.equal(validateSchema(operation.outputSchema, retry), null);
  assert.deepEqual(fake.calls, ['fast', 'fast', 'full']);
  await runChecks(f.db, input, person, 'retry', fake.services);
  const reuse = await runChecks(f.db, input, person, 'reuse', fake.services);
  assert.deepEqual(reuse.steps, []);
  assert.deepEqual(fake.calls, ['fast', 'fast', 'full']);
  await assert.rejects(runChecks(f.db, { ...input, commit: start }, person, 'wrong-candidate', fake.services), (error: unknown) =>
    error instanceof CommandFailure && error.code === 'candidate_missing');
});

test('R16/R30: checks.run reports the occupied full-check slot and resumes its pending request', async t => {
  const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']);
  const fake = fakeServices();
  const holder = await f.db.beginChecks({ attemptId: a.id, commit: head,
    checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person });
  const input = { attemptId: b.id, commit: head, dryRun: false };
  const plan = await runChecks(f.db, { ...input, dryRun: true }, person, 'waiting', fake.services);
  await assert.rejects(runChecks(f.db, input, person, 'waiting', fake.services), (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.code, 'checks_waiting');
    assert.equal(error.nextAction?.operation, 'checks.run');
    assert.equal((error.data.slotHolders as { claimId: string }[])[0]!.claimId, holder.executor!.claimId);
    return true;
  });
  assert.deepEqual(fake.calls, []);
  await f.db.finishChecks(holder.request.id, holder.executor!, { status: 'failed', evidenceKey: String(holder.request.input.evidenceKey), commands: [] });
  const result = await runChecks(f.db, input, person, 'waiting', fake.services);
  assert.deepEqual(result.steps, plan.steps);
  assert.deepEqual(fake.calls, ['fast', 'full']);
});

test('R08/R09/R16/R28/R30: exact interrupted check recovery retains diagnostics, releases only its claim and allows a new explicit run', async t => {
  for (const state of ['claimed', 'uncertain', 'released'] as const) {
    const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
    const admission = await f.db.beginChecks({ attemptId: a.id, commit: head,
      checks: mandatoryChecks(parseCheckPolicy(start, policyContent, contextChecks), parseCheckPolicy(start, policyContent, contextChecks)),
      profile, caller: person, requestKey: 'old-run' });
    if (state !== 'claimed') await f.db.finishChecks(admission.request.id, admission.executor!, {
      status: 'uncertain', evidenceKey: String(admission.request.input.evidenceKey),
      commands: [{ status: 'uncertain', stderr: 'Original interrupted diagnostic', exitCode: null }] });
    const commandFor = (key: string, input: Record<string, string | boolean>) => ({ requestKey: key,
      operation: 'checks.resolve', caller: person, input, fingerprint: canonicalJson(input) });
    if (state === 'released') {
      const input = { claimId: admission.executor!.claimId, confirmStopped: true, evidence: 'Exact owner stopped', dryRun: false };
      await f.db.resolveClaimByPerson(admission.executor!.claimId, input.evidence, person,
        { ...commandFor('release-claim', input), operation: 'claim.resolve' });
    }
    const original = f.db.request(admission.request.id), originalClaims = f.db.claims();
    assert.equal(acceptanceCheckFailure(a.id, head, original, originalClaims, f.db.requests()).nextAction?.operation, 'checks.resolve');
    assert.equal((requestView(f.db, original).nextAction as { operation: string }).operation, 'checks.resolve');
    const input = { checkRequestId: original.id, confirmStopped: true, evidence: 'Inspected this exact executor and its commands; all stopped', dryRun: false };
    const resolve = (key: string, value = input) => f.db.resolveChecksByPerson(value.checkRequestId,
      value.confirmStopped, value.evidence, value.dryRun, person, commandFor(key, value));
    const before = { events: f.db.events(), requests: f.db.requests(), claims: f.db.claims(), attempt: f.db.attempt(a.id) };
    const plan = await resolve('plan', { ...input, dryRun: true });
    assert.deepEqual({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims(), attempt: f.db.attempt(a.id) }, before);
    await assert.rejects(resolve('not-stopped', { ...input, confirmStopped: false }), /process_confirmation_required/);
    await assert.rejects(resolve('blank', { ...input, evidence: '  ' }));
    const result = await resolve('resolve');
    assert.equal(validateSchema(findOperation('checks.resolve')!.outputSchema, result), null);
    assert.deepEqual(result.steps, plan.steps);
    const recovered = f.db.request(original.id);
    assert.equal(recovered.state, 'withdrawn');
    assert.deepEqual({ ...recovered, state: original.state, revision: original.revision, result: original.result }, original);
    if (original.result) assert.deepEqual(recovered.result, original.result);
    else assert.equal(recovered.result?.status, 'uncertain');
    assert.ok(f.db.claim(admission.executor!.claimId).releasedAt);
    assert.deepEqual(f.db.claims().filter(c => c.id !== admission.executor!.claimId), originalClaims.filter(c => c.id !== admission.executor!.claimId));
    if (state === 'released') assert.deepEqual(f.db.claim(admission.executor!.claimId), originalClaims.find(c => c.id === admission.executor!.claimId));
    assert.equal(f.db.events().filter(e => e.kind === 'checks.resolved').length, 1);
    assert.equal((requestView(f.db, recovered).resolution as { evidence: string }).evidence, input.evidence);
    assert.equal(acceptanceCheckFailure(a.id, head, recovered, f.db.claims(), f.db.requests()).code, 'check_missing');
    const after = f.db.events();
    assert.deepEqual(await resolve('resolve'), result);
    assert.deepEqual(f.db.events(), after);
    await assert.rejects(resolve('resolve', { ...input, evidence: 'Changed evidence' }), /different|mismatch/iu);
    await assert.rejects(resolve('another-resolution'));
    assert.equal((await runCandidateChecks(f.db, a.id, person, fake.services, 'old-run')).state, 'withdrawn');
    await assert.rejects(runChecks(f.db, { attemptId: a.id, commit: head, dryRun: false }, person, 'old-run', fake.services),
      (error: unknown) => error instanceof CommandFailure && error.code === 'check_missing');
    assert.deepEqual(fake.calls, []);
    const retry = await runChecks(f.db, { attemptId: a.id, commit: head, dryRun: false }, person, 'new-run', fake.services);
    assert.equal(validateSchema(findOperation('checks.run')!.outputSchema, retry), null);
    assert.equal(f.db.requests().find(r => r.requestKey === 'new-run')!.state, 'succeeded');
    assert.equal(f.db.requests().find(r => r.requestKey === 'new-run')!.input.evidenceKey, original.input.evidenceKey);
    assert.deepEqual(fake.calls, ['fast', 'full']);
    assert.equal(f.db.request(original.id).result?.status, 'uncertain');
  }
});

test('R08/R09/R18/R28: checks.resolve refuses unrelated, pending and mismatched scope and untrusted authority', async t => {
  const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']);
  const begin = (attemptId: string) => f.db.beginChecks({ attemptId, commit: head,
    checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person });
  const active = await begin(a.id), pending = await begin(b.id);
  const operation = findOperation('checks.resolve')!;
  const input = { checkRequestId: active.request.id, confirmStopped: true, evidence: 'Stopped exact owner', dryRun: false };
  assert.deepEqual(operation.roles, ['person']);
  for (const bad of [{ ...input, caller: person }, { ...input, checkRequestId: 'not-a-uuid' }, { ...input, evidence: ' ' }, { ...input, confirmStopped: 'true' }]) {
    assert.notEqual(validateSchema(operation.inputSchema, bad), null);
  }
  const before = { events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() };
  for (const caller of [{ kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'objective', sessionId: 'session' }, { kind: 'worker' as const, attemptId: a.id }, host]) {
    await assert.rejects(executeCoreOperation(operation, input, () => {}, { config: f.path }, 'denied', { caller }), /person_required/);
  }
  for (const request of [pending.request, f.db.requests().find(r => r.operation !== 'checks.run')!]) {
    const value = { ...input, checkRequestId: request.id };
    await assert.rejects(f.db.resolveChecksByPerson(request.id, true, input.evidence, false, person,
      { requestKey: 'refused', operation: operation.name, caller: person, input: value, fingerprint: canonicalJson(value) }));
  }
  await assert.rejects(f.db.resolveChecksByPerson(active.request.id, true, input.evidence, false, person,
    { requestKey: 'wrong-scope', operation: operation.name, caller: person, input: { ...input, checkRequestId: pending.request.id }, fingerprint: 'wrong' }), /scope mismatch/);
  await assert.rejects(f.db.resolveChecksByPerson(active.request.id, true, input.evidence, false,
    { kind: 'supervisor', id: 'supervisor', objectiveId: 'objective', sessionId: 'session' },
    { requestKey: 'wrong-role', operation: operation.name, caller: person, input, fingerprint: canonicalJson(input) }), /person_required/);
  assert.deepEqual({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() }, before);
});

test('R08/R09/R16: recovery refuses mismatched persisted check claim scope without resolving anything', async t => {
  for (const mismatch of ['role', 'resource_key', 'attempt_id', 'owner_ref'] as const) {
    const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']);
    const admission = await f.db.beginChecks({ attemptId: a.id, commit: head,
      checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person });
    const sql = new DatabaseSync(f.path);
    defer(t, () => sql.close());
    const values = { role: 'maintenance', resource_key: 'checks:another-request', attempt_id: b.id,
      owner_ref: JSON.stringify({ kind: 'person', id: 'someone-else' }) };
    sql.prepare(`UPDATE claims SET ${mismatch} = ? WHERE id = ?`).run(values[mismatch], admission.executor!.claimId);
    const before = { events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() };
    for (const dryRun of [true, false]) {
      const input = { checkRequestId: admission.request.id, confirmStopped: true, evidence: 'Scoped evidence', dryRun };
      await assert.rejects(f.db.resolveChecksByPerson(admission.request.id, true, input.evidence, dryRun, person,
        { requestKey: 'refused', operation: 'checks.resolve', caller: person, input, fingerprint: canonicalJson(input) }), /scope mismatch/);
      assert.deepEqual({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims() }, before);
    }
  }
});

test('R15: trusted reservation freezes target checks and provenance; replay does not reread policy', async t => {
  const f = await checkFixture(t), fake = fakeServices();
  await f.db.addTask({ id: 'task', title: 'Task' }, person);
  const input = { requestKey: 'trusted-reservation', taskId: 'task', caller: person, startingCommit: start,
    delivery: { kind: 'code' as const, acceptance: 'review_or_integration' as const, requiredEvidence: [], requiredDeliverables: [] } };
  const reserved = await reserveWithTrustedChecks(f.db, input, fake.services.repository);
  assert.deepEqual(reserved.attempt.specification.checks, parseCheckPolicy(start, policyContent, contextChecks));
  fake.services.repository.readCheckPolicy = async () => { throw new Error('Policy no longer readable'); };
  const replay = await reserveWithTrustedChecks(f.db, input, fake.services.repository);
  assert.equal(replay.attempt.id, reserved.attempt.id); assert.equal(replay.replayed, true);
});

test('R15: configuration changes during policy resolution refuse before claiming a check slot', async t => {
  for (const field of ['revision', 'digest'] as const) {
    const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
    const configured = f.db.events().find(event => event.kind === 'context.configured')!;
    fake.services.repository.readCheckPolicy = async () => {
      await f.db.appendEvents([{ sourceKey: `context.configured:changed-${field}`, kind: 'context.configured',
        payloadVersion: 1, correlationId: 'configuration-change', actor: person, occurredAt: new Date().toISOString(),
        payload: { ...configured.payload, [field]: field === 'revision' ? 2 : 'new-policy-configuration' } }]);
      return parseCheckPolicy(start, policyContent, contextChecks);
    };
    await assert.rejects(runCandidateChecks(f.db, a.id, person, fake.services), /Configuration changed/);
    assert.deepEqual(fake.calls, []);
    assert.equal(f.db.requests().filter(request => request.operation === 'checks.run').length, 0);
    assert.equal(f.db.claims().filter(claim => claim.role === 'check_executor').length, 0);
  }
});

test('R15/R16: profile identity and ignored paths are detached before asynchronous policy reads', async t => {
  const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
  fake.services.profile = structuredClone(profile);
  fake.services.repository.readCheckPolicy = async () => {
    fake.services.profile.tools.node = 'changed';
    fake.services.profile.ignoredGeneratedPaths!.push('undeclared');
    return parseCheckPolicy(start, policyContent, contextChecks);
  };
  const observedPaths: string[][] = [];
  const inspect = fake.services.repository.inspectWorkspace;
  fake.services.repository.inspectWorkspace = async (workspace, forChecks, ignored) => {
    if (forChecks) observedPaths.push([...ignored!]);
    return inspect(workspace, forChecks, ignored);
  };
  const result = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.input.profile, profile);
  assert.ok(observedPaths.length > 0);
  assert.ok(observedPaths.every(paths => JSON.stringify(paths) === JSON.stringify(profile.ignoredGeneratedPaths)));
});

test('R16: missing terminal or validated result evidence refuses without starting commands', async t => {
  for (const stage of ['prepared', 'validated'] as const) {
    const f = await checkFixture(t), a = await f.attempt('task', ['Criterion'], undefined, head, start, policyContent, stage);
    const fake = fakeServices();
    await assert.rejects(runCandidateChecks(f.db, a.id, person, fake.services), /recorded candidate/);
    await assert.rejects(f.db.beginChecks({ attemptId: a.id, commit: head, checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person }), /terminal worker/);
    assert.deepEqual(fake.calls, []);
    assert.equal(f.db.claims().filter(claim => claim.role === 'check_executor').length, 0);
  }
});

test('R16: the worker observation path runs checks only after validated output and terminal evidence meet', async t => {
  const f = await checkFixture(t), a = await f.attempt('task', ['Criterion'], undefined, head, start, policyContent, 'validated');
  const fake = fakeServices();
  const terminal = a.observation('terminal', 2);
  await observeWorker(f.db, terminal, host, retention, { caller: person, services: fake.services });
  assert.deepEqual(fake.calls, ['fast', 'full']);
  await observeWorker(f.db, terminal, host, retention, { caller: person, services: fake.services });
  assert.deepEqual(fake.calls, ['fast', 'full']);
});

test('R15/R16: an explicit empty check set verifies the workspace and records a pass without removing acceptance hold', async t => {
  const empty = JSON.stringify({ version: 1, fast: [], full: [] });
  const f = await checkFixture(t), a = await f.attempt('task', ['Criterion'], undefined, head, start, empty), fake = fakeServices();
  fake.policy(null);
  const result = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(result.state, 'succeeded'); assert.deepEqual(result.result!.commands, []);
  assert.deepEqual(fake.calls, []); assert.equal(f.db.task('task').holdReason, 'awaiting_acceptance');
});

test('R16: fast then full serial order, successful evidence reuse and unchanged target policy', async t => {
  const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
  const first = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(first.state, 'succeeded'); assert.deepEqual(fake.calls, ['fast', 'full']);
  assert.equal(f.db.claims().filter(claim => claim.role === 'check_executor' && !claim.releasedAt).length, 0);
  fake.source(head);
  const replay = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(replay.id, first.id); assert.deepEqual(fake.calls, ['fast', 'full']);
  const reuse = await runCandidateChecks(f.db, a.id, person, fake.services, 'new-request');
  assert.equal(reuse.state, 'succeeded'); assert.deepEqual(fake.calls, ['fast', 'full']);
  assert.equal(f.db.events().filter(event => event.kind === 'checks.reused').length, 1);
  await assert.rejects(f.db.beginChecks({ attemptId: a.id, commit: start, checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person }), /terminal worker/);
});

test('R15: changed policy content, definition, profile versions and copied criteria require fresh commands', async t => {
  const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
  await runCandidateChecks(f.db, a.id, person, fake.services);
  fake.policy(policyContent + '\n');
  await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(fake.calls.length, 4);
  const changed = JSON.parse(policyContent); changed.full[0].timeoutMs++;
  fake.policy(JSON.stringify(changed));
  const definitions = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(definitions.state, 'succeeded');
  assert.deepEqual(fake.calls.slice(4), ['fast', 'full', 'full']);
  fake.services.profile = { ...profile, tools: { node: 'next' } };
  await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(fake.calls.length, 10);
  const b = await f.attempt('other', ['Different copied criterion']);
  await runCandidateChecks(f.db, b.id, person, fake.services);
  assert.equal(fake.calls.length, 13);
});

test('R16/A35: changed workspace or candidate fails and a later command is not run', async t => {
  for (const mutation of ['tracked', 'untracked', 'head', 'between', 'unknown'] as const) {
    const f = await checkFixture(t), a = await f.attempt(`task-${mutation}`), fake = fakeServices();
    if (mutation === 'between') fake.dirty();
    else if (mutation === 'unknown') fake.services.repository.inspectWorkspace = async () => uncertain('Cannot inspect');
    else fake.services.run = async check => { fake.calls.push(check.name); if (mutation === 'head') fake.move(); else fake.dirty(); return passed; };
    if (mutation === 'between' || mutation === 'unknown') {
      await assert.rejects(runCandidateChecks(f.db, a.id, person, fake.services),
        { code: mutation === 'between' ? 'workspace_dirty' : 'owner_unknown' });
      assert.deepEqual(fake.calls, []);
      continue;
    }
    const result = await runCandidateChecks(f.db, a.id, person, fake.services);
    assert.equal(result.state, 'rejected', mutation);
    assert.equal(f.db.task(`task-${mutation}`).holdReason, 'checks_failed');
    assert.ok(fake.calls.length <= 1);
    assert.notEqual(result.result!.status, 'passed');
  }
});

test('R16: failed evidence is not automatically rerun; a new explicit request may retry, replay never does', async t => {
  const f = await checkFixture(t), a = await f.attempt('task'), fake = fakeServices();
  fake.services.run = async check => { fake.calls.push(check.name); return { ...passed, status: 'failed', exitCode: 1 }; };
  const failure = await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.equal(failure.state, 'rejected'); assert.deepEqual(fake.calls, ['fast']);
  await runCandidateChecks(f.db, a.id, person, fake.services);
  assert.deepEqual(fake.calls, ['fast']);
  fake.services.run = async check => { fake.calls.push(check.name); return passed; };
  const retry = await runCandidateChecks(f.db, a.id, person, fake.services, 'retry-1');
  assert.equal(retry.state, 'succeeded'); assert.deepEqual(fake.calls, ['fast', 'fast', 'full']);
  await runCandidateChecks(f.db, a.id, person, fake.services, 'retry-1');
  assert.equal(fake.calls.length, 3);
});

test('R16: two database connections admit only one full run, show waiting and admit the waiter after confirmed completion', async t => {
  const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']);
  const other = await Database.open(f.path, f.options); defer(t, () => other.close());
  const fake = fakeServices();
  let entered!: () => void, release!: () => void;
  const fullEntered = new Promise<void>(resolve => { entered = resolve; });
  const fullRelease = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  fake.services.run = async check => {
    fake.calls.push(check.name);
    if (check.name === 'full') { active++; maximum = Math.max(maximum, active); entered(); await fullRelease; active--; }
    return passed;
  };
  const first = runCandidateChecks(f.db, a.id, person, fake.services);
  await fullEntered;
  const waiting = await runCandidateChecks(other, b.id, person, fake.services);
  assert.equal(waiting.state, 'pending'); assert.equal(other.attempt(b.id).phase, 'awaiting_checks');
  assert.deepEqual(fake.calls, ['fast', 'full']);
  release(); await first;
  assert.equal((await runCandidateChecks(other, b.id, person, fake.services)).state, 'succeeded');
  assert.equal(maximum, 1); assert.deepEqual(fake.calls, ['fast', 'full', 'fast', 'full']);
});

test('R08/R16/A35: long commands refresh their check claim every five seconds and stop on every outcome', async t => {
  for (const ending of ['passed', 'failed', 'uncertain', 'throw'] as const) {
    const f = await checkFixture(t), a = await f.attempt('one'), fake = fakeServices();
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    const pulses: { heartbeatAt: string; now: number }[] = [];
    let reservations = 0;
    fake.services.run = async check => {
      fake.calls.push(check.name);
      for (let pulse = 0; pulse < 9; pulse++) {
        t.mock.timers.tick(5000);
        await setImmediate();
        const claim = f.db.claims().find(claim => claim.role === 'check_executor')!;
        pulses.push({ heartbeatAt: claim.heartbeatAt, now: Date.now() });
        // Keep the fixture's other owners fresh, as the dispatch loop does.
        for (const owner of f.db.claims().filter(value => value.role !== 'check_executor' && !value.releasedAt)) {
          await f.db.refreshClaim({ claimId: owner.id, generation: owner.generation }, new Date().toISOString(), person);
        }
      }
      // Reservation uses the same unresolved-claim guard as a parallel dispatch.
      if (check.name === 'fast') {
        await f.db.addTask({ id: 'parallel', title: 'Parallel' }, person);
        await f.db.reserveAttempt({ requestKey: 'parallel', taskId: 'parallel', caller: person, startingCommit: start,
          checks: parseCheckPolicy(start, policyContent, contextChecks),
          delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
        reservations++;
      }
      if (ending === 'throw') throw new Error('Interrupted owner');
      return { ...passed, status: ending, exitCode: ending === 'passed' ? 0 : ending === 'failed' ? 1 : null };
    };
    const result = await runCandidateChecks(f.db, a.id, person, fake.services);
    assert.equal(result.state, ending === 'passed' ? 'succeeded' : ending === 'failed' ? 'rejected' : 'uncertain');
    assert.deepEqual(fake.calls, ending === 'passed' ? ['fast', 'full'] : ['fast']);
    assert.equal(reservations, 1);
    assert.equal(pulses.length, ending === 'passed' ? 18 : 9);
    for (const pulse of pulses) {
      assert.equal(pulse.heartbeatAt, new Date(pulse.now).toISOString());
      assert.equal(heartbeatStatus(pulse.heartbeatAt, pulse.now), 'fresh');
    }
    const claim = f.db.claims().find(claim => claim.role === 'check_executor')!;
    t.mock.timers.tick(35000);
    await setImmediate();
    assert.deepEqual(f.db.claims().find(value => value.id === claim.id), claim);
    assert.equal(heartbeatStatus(claim.heartbeatAt, Date.now()), 'stale');
    assert.equal(claim.releasedAt === null, result.state === 'uncertain');
    t.mock.timers.reset();
  }
});

test('R08/R16/A35: a failed heartbeat stops refreshing and prevents later check commands', async t => {
  const f = await checkFixture(t), a = await f.attempt('one'), fake = fakeServices();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const refresh = t.mock.method(f.db, 'refreshClaim', async () => { throw new Error('Lost storage'); });
  fake.services.run = async check => {
    fake.calls.push(check.name);
    t.mock.timers.tick(5000);
    await setImmediate();
    return passed;
  };
  assert.equal((await runCandidateChecks(f.db, a.id, person, fake.services)).state, 'uncertain');
  assert.deepEqual(fake.calls, ['fast']);
  t.mock.timers.tick(35000);
  await setImmediate();
  assert.equal(refresh.mock.callCount(), 1);
  assert.equal(f.db.claims().find(claim => claim.role === 'check_executor')!.releasedAt, null);
});

test('R16: killing a separate executor process preserves its durable request and check slot', async t => {
  const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']);
  const databaseModule = new URL('../../src/storage/database.ts', import.meta.url).href;
  const input = { attemptId: a.id, commit: head, checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person };
  const script = `import { Database } from ${JSON.stringify(databaseModule)};
    const db = await Database.open(${JSON.stringify(f.path)}, ${JSON.stringify(f.options)});
    const admission = await db.beginChecks(${JSON.stringify(input)});
    process.stdout.write(JSON.stringify(admission), () => process.kill(process.pid, 'SIGKILL'));`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.error, undefined); assert.notEqual(killed.status, 0);
  const admission = JSON.parse(killed.stdout);
  assert.equal(admission.execute, true);
  assert.equal(f.db.request(admission.request.id).state, 'claimed');
  const claim = f.db.claims().find(value => value.role === 'check_executor')!;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  t.mock.timers.tick(35000);
  await setImmediate();
  assert.deepEqual(f.db.claims().find(value => value.id === claim.id), claim);
  assert.equal(heartbeatStatus(claim.heartbeatAt, Date.now()), 'stale');
  const fake = fakeServices();
  assert.equal((await runCandidateChecks(f.db, b.id, person, fake.services)).state, 'pending');
  assert.deepEqual(fake.calls, []);
  assert.equal(f.db.claims().filter(value => value.role === 'check_executor' && !value.releasedAt).length, 1);
});

test('R16: a killed or interrupted executor remains uncertain and keeps its concurrency slot, even with a new request', async t => {
  for (const interruption of ['signal', 'throw', 'lost-executor']) {
    const f = await checkFixture(t), a = await f.attempt('one'), b = await f.attempt('two', ['Other criterion']), fake = fakeServices();
    if (interruption === 'lost-executor') {
      await f.db.beginChecks({ attemptId: a.id, commit: head, checks: parseCheckPolicy(start, policyContent, contextChecks), profile, caller: person });
    } else {
      fake.services.run = async () => { if (interruption === 'throw') throw new Error('secret diagnostic'); return { ...passed, status: 'uncertain', exitCode: null }; };
      assert.equal((await runCandidateChecks(f.db, a.id, person, fake.services)).state, 'uncertain');
      assert.equal(f.db.task('one').holdReason, 'checks_uncertain');
    }
    const claim = f.db.claims().find(value => value.role === 'check_executor')!;
    await f.db.refreshClaim({ claimId: claim.id, generation: claim.generation }, '2000-01-01T00:00:00.000Z', person);
    assert.equal((await runCandidateChecks(f.db, b.id, person, fake.services)).state, 'pending');
    assert.equal((await runCandidateChecks(f.db, a.id, person, fake.services, 'try-again')).state, 'pending');
    assert.equal(f.db.claims().filter(value => value.role === 'check_executor' && !value.releasedAt).length, 1);
  }
});
