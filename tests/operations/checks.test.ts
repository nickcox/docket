import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { heartbeatStatus } from '../../src/storage/claims.ts';
import { confirmed, uncertain } from '../../src/adapters/command.ts';
import type { CheckCommandResult } from '../../src/adapters/checks.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { runCandidateChecks } from '../../src/checks.ts';
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
      inspectWorkspace: async () => confirmed({ branch: 'refs/heads/worker', head: candidate, clean, uncommitted: clean ? [] : ['file'], untracked: [] }) },
    run: async check => { calls.push(check.name); return passed; } };
  return { services, calls, policy: (value: string | null) => { content = value; }, source: (value: string) => { sourceCommit = value; },
    dirty: () => { clean = false; }, move: () => { candidate = start; } };
}

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
    observedPaths.push([...ignored!]);
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
