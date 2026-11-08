import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmed, uncertain } from '../../src/adapters/command.ts';
import type { CheckCommandResult } from '../../src/adapters/checks.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { runCandidateChecks } from '../../src/checks.ts';
import type { CheckServices } from '../../src/checks.ts';
import { Database } from '../../src/storage/database.ts';
import { checkFixture, contextChecks, head, person, policyContent, profile, start } from '../helpers/check-attempt.ts';

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

test('R16: terminal/result gate, fast then full serial order, successful evidence reuse and unchanged target policy', async t => {
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
  const other = await Database.open(f.path, f.options); t.after(() => other.close());
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
