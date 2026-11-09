import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { checkFixture, person, head, start, host } from '../helpers/check-attempt.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';
import { dispatch } from '../../src/dispatch.ts';
import { catalogue } from '../../src/catalog.ts';
import { piWorkerPrompt } from '../../src/adapters/pi.ts';
import { continuationEvidence, continuationHandover } from '../../src/continuation.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import type { Runtime } from '../../src/runtime.ts';
import type { Allocation } from '../../src/storage/reservations.ts';

async function fixture(t: Parameters<typeof checkFixture>[0], candidate = true, invalid = false) {
  const f = await checkFixture(t);
  const source = invalid
    ? await f.attempt('task', ['Criterion'], undefined, head, start, undefined, 'prepared')
    : await f.attempt('task');
  if (invalid) {
    await writeFile(source.binding.resultPath, '{');
    await f.db.recordWorkerObservation(source.observation('terminal', 1), host);
    await assert.rejects(f.db.completeWorker(source.id, host), { code: 'result_invalid' });
  }
  using sql = new DatabaseSync(f.path);
  // This fixture records terminal evidence directly, without activating a worker.
  sql.prepare("UPDATE requests SET state = 'succeeded', result = '{}' WHERE attempt_id = ? AND operation = 'worker.activate'").run(source.id);
  if (!candidate) sql.prepare("UPDATE attempts SET candidate = NULL, outcome = 'failed' WHERE id = ?").run(source.id);
  await f.db.reopenTask('task', person);
  await f.db.releaseTask('task', person);
  let output = head, clean = true, retained = true, acquired = 0;
  const pins = new Map<string, string>();
  const allocations: Allocation[] = [];
  let movedPin = false, uncertainCleanup = false, dirtyAfterPin = false;
  const launcher = new FakeLauncher();
  launcher.afterActivate = async () => {
    for (const worker of launcher.workers.values()) worker.terminal = true;
    return confirmed({ admitted: true });
  };
  const inspect = launcher.inspect.bind(launcher);
  launcher.inspect = async reference => {
    const state = await inspect(reference);
    return state.status === 'known' ? { ...state, turnFailure: { kind: 'model_error', message: 'Test stops new worker' } } : state;
  };
  const repository = {
    inspectRef: async (ref: string) => confirmed(ref.startsWith('refs/docket/')
      ? pins.has(ref) ? { state: 'present', commit: pins.get(ref)! } : { state: 'absent' }
      : retained ? { state: 'present', commit: output } : { state: 'absent' }),
    inspectWorkspace: async () => confirmed({ clean, head, branch: null, untracked: clean ? [] : ['unfinished'], uncommitted: [] }),
    compare: async (ancestor: string, descendant: string) => confirmed([start, head].includes(ancestor) && [start, head].includes(descendant)),
    command: async () => ({ complete: true, code: 0, stdout: 'Inherited work\n', stderr: '' }),
    readCheckPolicy: async () => parseCheckPolicy(start, null, { executionProfile: 'node-v1', fast: [], full: [] }),
    createPinnedRef: async (ref: string, commit: string) => { assert.equal(pins.has(ref), false); pins.set(ref, commit); if (dirtyAfterPin) clean = false; return confirmed({ ref, commit }); },
    conditionalDeleteRef: async (ref: string, commit: string) => {
      if (uncertainCleanup) return uncertain('Test interrupted cleanup');
      if (pins.get(ref) !== commit) return rejected('Pin moved; preserved');
      pins.delete(ref); return confirmed({ ref, commit: null });
    },
  };
  const runtime = { repository, launcher, workspace: { options: { poolRoot: source.allocation.pool },
    acquire: async (input: { startingCommit: string; attemptId: string; holder: string; branch: string }) => {
      acquired++;
      assert.equal([...pins.values()][0], input.startingCommit);
      if (movedPin) for (const ref of pins.keys()) pins.set(ref, 'd'.repeat(40));
      output = 'c'.repeat(40); // The source ref moves after reservation.
      const allocation = { ...source.allocation, leaseId: `lease:${input.attemptId}`, path: join(source.allocation.pool, input.attemptId),
        startingCommit: input.startingCommit, outputRef: `refs/heads/${input.branch}`, holder: JSON.parse(input.holder) };
      allocations.push(allocation);
      return confirmed(allocation);
    } }, completion: { repository, workspace: { inspect: async () => confirmed({ state: 'matching' }) } } } as unknown as Runtime;
  const args: Parameters<typeof dispatch>[1] = { taskId: 'task', sourceAttemptId: source.id, sourceCommit: null, profile: null, note: 'Check inherited work', dryRun: false };
  return { ...f, source, runtime, launcher, args, pins, allocations, acquired: () => acquired,
    dirty: () => { clean = false; }, missing: () => { retained = false; },
    movePin: () => { movedPin = true; }, interruptCleanup: () => { uncertainCleanup = true; },
    dirtyOnPin: () => { dirtyAfterPin = true; } };
}

for (const [candidate, chosen] of [[true, false], [false, false], [false, true]]) test(`R12/A26: continuation freezes commit with candidate=${candidate}, chosen=${chosen}; allocates and prompts only a new session; replay is inert`, async t => {
  const f = await fixture(t, candidate);
  if (chosen) f.args.sourceCommit = start;
  const expected = chosen ? start : head;
  const before = [f.db.requests(), f.db.events(), f.db.claims()];
  const plan = await dispatch(f.db, { ...f.args, dryRun: true }, person, 'continue', f.runtime, () => {});
  assert.equal('startingCommit' in plan && plan.startingCommit, expected);
  assert.equal('subject' in plan && plan.subject, 'Inherited work');
  assert.deepEqual([f.db.requests(), f.db.events(), f.db.claims()], before);
  await assert.rejects(dispatch(f.db, f.args, person, 'continue', f.runtime, () => {}), { code: 'worker_failed' });
  const request = f.db.requests().find(r => r.requestKey === 'continue')!;
  const next = f.db.attempt(request.attemptId!);
  assert.notEqual(next.id, f.source.id);
  assert.equal(next.number, 2);
  assert.equal(next.specification.startingCommit, expected);
  assert.equal(next.allocation!.startingCommit, expected);
  assert.notEqual(next.allocation!.leaseId, f.source.allocation.leaseId);
  assert.equal(f.pins.size, 0);
  assert.equal(f.acquired(), 1);
  assert.equal(f.launcher.prompts.length, 1);
  assert.equal(f.launcher.prompts[0]!.input.attemptId, next.id);
  assert.deepEqual(next.specification.handover, continuationHandover(f.db, f.source.id, expected, chosen!, f.args.note ?? null));
  const binding = [...f.launcher.workers.values()][0]!.binding;
  const prompt = piWorkerPrompt(binding);
  assert.ok(prompt.includes(JSON.stringify(next.specification.handover)));
  assert.match(prompt, /rather than trusting it/);
  assert.match(prompt, /Artefact references must name files inside artefactsDirectory, not directories/);
  assert.notEqual(binding.sessionId, f.source.binding.identity.sessionId);
  const sourceBefore = f.db.attempt(f.source.id);
  const replay = await dispatch(f.db, f.args, person, 'continue', f.runtime, () => {});
  assert.equal('replayed' in replay && replay.replayed, true);
  assert.equal(f.acquired(), 1);
  assert.equal(f.launcher.prompts.length, 1);
  assert.deepEqual(f.db.attempt(f.source.id), sourceBefore);
  await assert.rejects(dispatch(f.db, { ...f.args, sourceCommit: chosen ? head : start }, person, 'continue', f.runtime, () => {}), { code: 'request_input_mismatch' });
});

test('R12/A19: an invalid-result held attempt continues from its retained branch without a candidate', async t => {
  const f = await fixture(t, true, true);
  assert.equal(f.db.attempt(f.source.id).outcome, 'held');
  assert.equal(f.db.attempt(f.source.id).candidate, null);
  assert.equal(f.db.invalidWorkerResult(f.source.id)!.message, 'Malformed result JSON');
  await assert.rejects(dispatch(f.db, f.args, person, 'continue-invalid', f.runtime, () => {}), { code: 'worker_failed' });
  const next = f.db.attempt(f.db.requests().find(r => r.requestKey === 'continue-invalid')!.attemptId!);
  assert.equal(next.specification.startingCommit, head);
  assert.equal(f.allocations[0]!.startingCommit, head);
  assert.equal(f.db.attempt(f.source.id).outcome, 'held');
});

test('R12/A26: person chooses an earlier commit; unrelated commits refuse', async t => {
  const f = await fixture(t);
  const evidence = await continuationEvidence(f.db, f.source.id, 'task', f.runtime, start);
  assert.equal(evidence.startingCommit, start);
  await assert.rejects(continuationEvidence(f.db, f.source.id, 'task', f.runtime, 'd'.repeat(40)), { code: 'policy_refused' });
  const handover = continuationHandover(f.db, f.source.id, start, true, 'note');
  assert.equal(handover.personChoseCommit, true);
  assert.deepEqual(handover.reviewFindings, []);
  assert.deepEqual(catalogue.operations.find(o => o.name === 'attempt.continue')!.roles, ['person']);
});

test('R12/A26: moved pin is retained and uncertain cleanup is reported without launching', async t => {
  for (const moved of [true, false]) {
    const f = await fixture(t);
    if (moved) f.movePin(); else f.interruptCleanup();
    const messages: string[] = [];
    await assert.rejects(dispatch(f.db, f.args, person, 'cleanup', f.runtime, m => messages.push(m)),
      { code: moved ? 'worker_failed' : 'effect_uncertain' });
    assert.equal(f.acquired(), 1);
    assert.equal(f.pins.size, 1);
    assert.equal([...f.pins.values()][0], moved ? 'd'.repeat(40) : head);
    assert.equal(f.db.requests().find(r => r.operation === 'continuation.cleanup-pin')!.state, moved ? 'rejected' : 'uncertain');
    assert.ok(messages.some(m => m.startsWith('continuation.cleanup-pin:')));
    if (!moved) assert.equal(f.launcher.prompts.length, 0);
  }
});

test('R12/A27: source workspace is rechecked before allocation and settled source cannot gain launch permission', async t => {
  const f = await fixture(t);
  f.dirtyOnPin();
  await assert.rejects(dispatch(f.db, f.args, person, 'dirty-after-pin', f.runtime, () => {}), { code: 'workspace_dirty' });
  assert.equal(f.acquired(), 0);
  assert.equal(f.launcher.prompts.length, 0);
  const owner = f.db.claims().find(c => c.attemptId === f.source.id && c.role === 'worker_owner')!;
  using sql = new DatabaseSync(f.path);
  // A paused creator with an old pending decision must not resurrect a terminal source.
  sql.prepare("UPDATE attempts SET launch_state = 'pending' WHERE id = ?").run(f.source.id);
  await assert.rejects(f.db.decideWorkerLaunch(f.source.id, owner.id, 'permit', host));
  assert.equal(f.db.attempt(f.source.id).launchState, 'pending');
});

for (const condition of ['dirty', 'missing', 'running', 'unresolved', 'lease', 'limit', 'capacity', 'profile', 'wrong-task'] as const) {
  test(`R12/A27: ${condition} refuses before reservation or allocation`, async t => {
    const f = await fixture(t);
    using sql = new DatabaseSync(f.path);
    if (condition === 'dirty') f.dirty();
    if (condition === 'missing') f.missing();
    if (condition === 'running') sql.prepare("UPDATE attempts SET execution_open = 1, phase = 'running' WHERE id = ?").run(f.source.id);
    if (condition === 'unresolved') sql.prepare("UPDATE requests SET state = 'uncertain' WHERE attempt_id = ? AND operation = 'worker.activate'").run(f.source.id);
    if (condition === 'wrong-task') f.args.taskId = 'different';
    if (['lease', 'limit', 'capacity'].includes(condition)) {
      await f.db.addTask({ id: 'other', title: 'Other' }, person);
      for (let number = 1; number <= (condition === 'limit' ? 2 : condition === 'lease' ? 1 : 10); number++) {
        if (condition === 'capacity') await f.db.addTask({ id: `capacity-${number}`, title: 'Capacity' }, person);
        sql.prepare(`INSERT INTO attempts (id, task_id, number, execution_open, phase, specification, output_ref, lease_state, created_at)
          VALUES (?, ?, ?, ?, 'settled', '{}', ?, ?, 'now')`).run(`extra-${number}`, condition === 'capacity' ? `capacity-${number}` : 'task',
          condition === 'capacity' ? number : number + 1, condition === 'capacity' ? 1 : 0, `extra-ref-${number}`, condition === 'lease' ? 'held' : 'returned');
      }
    }
    if (condition === 'profile') await f.db.appendEvents([{ sourceKey: 'test:limited', kind: 'profile.limited', payloadVersion: 1,
      correlationId: 'test', actor: person, occurredAt: new Date().toISOString(), payload: { profile: 'worker', message: 'Quota' } }]);
    const before = f.db.requests().length;
    await assert.rejects(dispatch(f.db, f.args, person, 'refused', f.runtime, () => {}));
    assert.equal(f.db.requests().length, before);
    assert.equal(f.acquired(), 0);
    assert.equal(f.launcher.prompts.length, 0);
  });
}
