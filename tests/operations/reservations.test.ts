import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { reserveAndAllocate, WorkspaceAcquisitionError } from '../../src/attempts.ts';
import { applicationId, Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, JsonObject, StoredEvent } from '../../src/storage/database.ts';
import type { Allocation, ReservationInput } from '../../src/storage/reservations.ts';

const actor = { kind: 'person' as const, id: 'operator' };
const hash = 'a'.repeat(40);
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';
const mismatch = (error: unknown) => error instanceof StorageError && error.code === 'request_input_mismatch';
export function configuration(root: string): JsonObject {
  const profile = { launcher: 'bb', provider: 'example', model: 'model', reasoning: null,
    runMs: 1000, maxCost: 0, maxTokens: null, executionProfile: 'bb-worker-v1' };
  return { version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
    limits: { maxAttempts: 2, maxAttemptsPerTask: 3, maxConcurrentFullChecks: 1 },
    profiles: { worker: profile, alternate: { ...profile, launcher: 'pi' } }, defaultProfile: 'worker',
    profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
    finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] } };
}
function input(requestKey = 'dispatch', taskId?: string): ReservationInput {
  return { requestKey, caller: actor, ...(taskId === undefined ? {} : { taskId }), startingCommit: hash,
    checks: { sourceCommit: hash, digest: 'checks-sha256', fast: [{ name: 'types', command: ['npm', 'run', 'check'], timeoutMs: 1000 }], full: [] },
    delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: ['tests'], requiredDeliverables: [] } };
}
async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-reserve-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, readOnly: false, retryMs: 1000 };
  const db = await Database.initialise(path, { contextId: 'reservations', repository: { identity: 'example' },
    stateDirectory: root, createdBy: actor, configuration: { revision: 1, resolved: configuration(root), digest: 'config-1', provenance: {} } }, options);
  defer(t, () => db.close());
  const [claim] = await db.registerClaims([{ resourceKey: 'dispatch', role: 'maintenance', generation: 'generation', ownerRef: actor,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], actor);
  const executor = { claimId: claim!.id, generation: claim!.generation };
  return { db, root, path, options, executor };
}
async function add(db: Database, id: string, profile?: string) {
  return db.addTask({ id, title: id, instructions: 'Implement the task', criteria: ['It works'], profile: profile ?? null }, actor);
}
function allocation(request: { input: JsonObject }): Allocation {
  const workspace = request.input.workspace as JsonObject;
  return { leaseId: 'lease', holder: workspace.holder as JsonObject,
    path: join(workspace.pool as string, '.treehouse', 'example', '7', 'example'), pool: workspace.pool as string,
    repository: request.input.repository as JsonObject, outputRef: request.input.outputRef as string, startingCommit: request.input.startingCommit as string };
}
function snapshot(db: Database, path: string) {
  using sql = new DatabaseSync(path, { readOnly: true });
  return { attempts: sql.prepare('SELECT * FROM attempts ORDER BY id').all(), requests: db.requests(), events: db.events(), tasks: db.tasks() };
}

test('R02/R03/R04: automatic selection skips blocked tasks and agrees with dependency completion and removal', async t => {
  const { db, path } = await fixture(t);
  for (const id of ['dependent', 'blocker', 'next']) await add(db, id);
  await db.addBlocker('dependent', 'blocker', actor);
  const before = snapshot(db, path);
  await assert.rejects(db.reserveAttempt(input('named', 'dependent')), conflict);
  assert.deepEqual(snapshot(db, path), before);
  assert.equal((await db.reserveAttempt(input('preview'), true)).attempt.taskId, 'blocker');
  assert.equal((await db.reserveAttempt(input('automatic'))).attempt.taskId, 'blocker');
  await db.markTaskDone('blocker', actor);
  assert.equal((await db.reserveAttempt(input('done-preview'), true)).attempt.taskId, 'dependent');
  await db.reopenTask('blocker', actor);
  assert.equal((await db.reserveAttempt(input('reopened-preview'), true)).attempt.taskId, 'next');
  await db.removeBlocker('dependent', 'blocker', actor);
  assert.equal((await db.reserveAttempt(input('unblocked-preview'), true)).attempt.taskId, 'dependent');
});

test('R04/R05: reserve a numbered immutable specification with resolved profile, checks and unique output namespace', async t => {
  const { db, root } = await fixture(t);
  const task = await add(db, 'one');
  const reservation = await db.reserveAttempt(input());
  assert.equal(reservation.replayed, false);
  const { attempt } = reservation;
  assert.equal(attempt.number, 1);
  assert.equal(attempt.phase, 'reserved');
  assert.equal(attempt.launchState, 'pending');
  assert.equal(attempt.executionOpen, true);
  assert.equal(attempt.allocation, null);
  const spec = attempt.specification;
  assert.deepEqual(spec.task, task);
  assert.equal(spec.definitionRevision, 1);
  assert.deepEqual(spec.criteria, ['It works']);
  assert.equal(spec.profileName, 'worker');
  assert.equal(spec.profileSource, 'profileByKind.code');
  assert.deepEqual(spec.profile, (configuration(root).profiles as JsonObject).worker);
  assert.deepEqual(spec.checks, input().checks);
  assert.equal(spec.baseBranch, 'main');
  assert.equal(spec.targetBranch, 'main');
  const databaseId = db.events()[0]!.payload.databaseId;
  assert.equal(spec.outputRef, `refs/heads/docket/${databaseId}/${attempt.id}`);
  assert.deepEqual(spec.workspace, { holder: { databaseId, contextId: 'reservations', taskId: task.id, attemptId: attempt.id },
    pool: join(root, 'pool') });
  assert.deepEqual(spec.delivery, { ...input().delivery, baseRef: 'main', startingCommit: hash, outputBranch: spec.outputRef });
  assert.equal(db.task('one').state, 'queued');
  assert.equal(db.requests()[0]!.attemptId, attempt.id);
  assert.equal(db.events().at(-1)!.kind, 'attempt.reserved');
});

test('R29: explicit profile wins over task, which wins over kind; settings are frozen', async t => {
  const { db } = await fixture(t);
  await add(db, 'one', 'alternate'); await add(db, 'two', 'alternate');
  const first = await db.reserveAttempt(input('one', 'one'));
  assert.equal(first.attempt.specification.profileSource, 'task');
  assert.equal((first.attempt.specification.profile as JsonObject).launcher, 'pi');
  const second = await db.reserveAttempt({ ...input('two', 'two'), profile: 'worker' });
  assert.equal(second.attempt.specification.profileSource, 'dispatch');
  assert.equal((second.attempt.specification.profile as JsonObject).launcher, 'bb');
  await db.updateTaskDefinition('one', { profile: 'worker' }, actor);
  assert.deepEqual(db.attempt(first.attempt.id), first.attempt);
});

test('A06/R04: capacity, readiness, retained lifetime attempts and leases constrain selection, not just task state', async t => {
  const { db, path } = await fixture(t);
  for (const id of ['held', 'blocked', 'old', 'lease', 'first', 'second', 'third']) await add(db, id);
  await db.holdTask('held', 'Wait', actor);
  await db.addBlocker('blocked', 'held', actor);
  using seed = new DatabaseSync(path);
  for (let number = 1; number <= 3; number++) seed.prepare(`INSERT INTO attempts (id, task_id, number, execution_open, phase, specification, output_ref, outcome, created_at)
    VALUES (?, 'old', ?, 0, 'settled', '{}', ?, 'held', 'now')`).run(`older-${number}`, number, `older-ref-${number}`);
  seed.prepare(`INSERT INTO attempts (id, task_id, number, execution_open, phase, specification, output_ref, allocation, lease_id, lease_state, created_at)
    VALUES ('retained', 'lease', 1, 0, 'settled', '{}', 'retained-ref', '{"leaseId":"retained-lease"}', 'retained-lease', 'held', 'now')`).run();
  for (const id of ['held', 'blocked', 'old', 'lease']) await assert.rejects(db.reserveAttempt(input(`named-${id}`, id)), conflict);
  const one = await db.reserveAttempt(input('auto-1'));
  const two = await db.reserveAttempt(input('auto-2'));
  assert.equal(one.attempt.taskId, 'first'); assert.equal(two.attempt.taskId, 'second');
  await assert.rejects(db.reserveAttempt(input('same-task', 'first')), conflict);
  await assert.rejects(db.reserveAttempt(input('capacity', 'third')), conflict);
  seed.prepare("UPDATE attempts SET execution_open = 0, outcome = 'held', phase = 'settled' WHERE id = ?").run(one.attempt.id);
  const next = await db.reserveAttempt(input('next', 'first'));
  assert.equal(next.attempt.number, 2);
});

test('A07/A08/R04: replay compares logical input first and returns current progress despite task/config/evidence changes', async t => {
  const { db, executor, path } = await fixture(t);
  await add(db, 'one'); await add(db, 'two');
  let calls = 0;
  const provider = { acquire: async (request: { input: JsonObject }) => { calls++; return allocation(request); } };
  const original = await reserveAndAllocate(db, input(), executor, provider);
  await db.holdTask('one', 'Hold after allocation', actor);
  await db.updateTaskDefinition('one', { title: 'Changed' }, actor);
  using sql = new DatabaseSync(path);
  // Even unusable current configuration/evidence does not cause a repeat to resolve again.
  sql.prepare("UPDATE events SET payload = '{\"revision\":2,\"resolved\":{}}' WHERE kind = 'context.configured'").run();
  const repeated = await reserveAndAllocate(db, { ...input(), startingCommit: 'unresolved', checks: {} as ReservationInput['checks'] }, executor, provider);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.attempt, original.attempt);
  assert.equal(calls, 1);
  const before = snapshot(db, path);
  for (const changed of [{ taskId: 'one' }, { taskId: 'two' }, { profile: 'worker' }, { caller: { ...actor, id: 'other' } },
    { note: 'different' }, { sourceAttemptId: original.attempt.id }]) {
    await assert.rejects(reserveAndAllocate(db, { ...input(), ...changed }, executor, provider), mismatch);
  }
  await assert.rejects(db.recordCommand({ requestKey: 'dispatch', operation: 'other', caller: actor, fingerprint: 'x', input: {} }), mismatch);
  assert.deepEqual(snapshot(db, path), before);
  assert.equal(calls, 1);
});

test('R04/R29: named revisions and missing or invalid policy refuse without recording requests', async t => {
  const { db, root, path } = await fixture(t);
  await add(db, 'one');
  for (const patch of [{ expectedDefinitionRevision: 2 }, { expectedDecisionRevision: 1 }, { expectedConfigRevision: 2 }, { expectedConfigDigest: 'different' }]) {
    await assert.rejects(db.reserveAttempt({ ...input(), ...patch }), conflict);
  }
  using seed = new DatabaseSync(path);
  const original = db.events().find(event => event.kind === 'context.configured')!;
  for (const broken of [ {}, { ...configuration(root), limits: { maxAttempts: 0, maxAttemptsPerTask: 3 } },
    { ...configuration(root), finalisation: {} }, { ...configuration(root), baseBranch: '' },
    { ...configuration(root), profiles: { worker: { ...(configuration(root).profiles as JsonObject).worker as JsonObject, secret: 'do not persist' } } },
    { ...configuration(root), profiles: { ...(configuration(root).profiles as JsonObject), inactive: { launcher: 'bb' } } },
    { ...configuration(root), defaultProfile: 'toString' },
    { ...configuration(root), profileByKind: { code: 'worker', report: 'worker', review: 'toString' } },
    { ...configuration(root), profileByKind: { code: 'worker', report: 'worker', review: 'worker', unknown: 'worker' } } ]) {
    seed.prepare("UPDATE events SET payload = ? WHERE kind = 'context.configured'").run(JSON.stringify({ ...original.payload, resolved: broken }));
    const before = snapshot(db, path);
    await assert.rejects(db.reserveAttempt(input()));
    assert.deepEqual(snapshot(db, path), before);
  }
  seed.prepare("UPDATE events SET payload = ? WHERE kind = 'context.configured'").run(JSON.stringify(original.payload));
  await assert.rejects(db.reserveAttempt({ ...input(), profile: 'unknown' }), /not configured/);
  await assert.rejects(db.reserveAttempt({ ...input(), checks: { ...input().checks, sourceCommit: 'not-a-commit' } }), /commit/);
  assert.equal(db.requests().length, 0);
});

test('R29: task profile validation refuses add and update atomically, naming the field and configured names', async t => {
  const { db, path } = await fixture(t);
  await add(db, 'one');
  const before = snapshot(db, path);
  for (const profile of ['missing', 'toString']) {
    await assert.rejects(add(db, 'bad', profile), /Profile.*not configured.*alternate, worker/);
    await assert.rejects(db.updateTaskDefinition('one', { title: 'Changed', profile }, actor), /Profile.*not configured/);
    assert.deepEqual(snapshot(db, path), before);
  }
});

test('R04/R29: automatic reservation skips a removed task profile, with identical dry-run and replay reasons', async t => {
  const { db, path } = await fixture(t);
  await add(db, 'removed', 'alternate'); await add(db, 'next');
  using seed = new DatabaseSync(path);
  const event = db.events().find(e => e.kind === 'context.configured')!;
  const resolved = event.payload.resolved as JsonObject;
  delete (resolved.profiles as JsonObject).alternate;
  seed.prepare("UPDATE events SET payload = ? WHERE kind = 'context.configured'").run(JSON.stringify(event.payload));
  const before = snapshot(db, path);
  await assert.rejects(db.reserveAttempt(input('named', 'removed')), /Profile "alternate" is not configured/);
  const plan = await db.reserveAttempt(input(), true);
  assert.equal(plan.attempt.taskId, 'next');
  assert.deepEqual(plan.skippedTasks, [{ taskId: 'removed', reason: 'Profile "alternate" is not configured. Configured names: worker.' }]);
  assert.deepEqual(snapshot(db, path), before);
  const reserved = await db.reserveAttempt(input());
  assert.equal(reserved.attempt.taskId, 'next');
  assert.deepEqual(reserved.skippedTasks, plan.skippedTasks);
  assert.deepEqual((await db.reserveAttempt(input())).skippedTasks, plan.skippedTasks);
  assert.equal(db.task('removed').state, 'queued');
});

test('R04: objective-linked tasks refuse by name and automatic selection skips them', async t => {
  const { db, path } = await fixture(t);
  await add(db, 'objective'); await add(db, 'plain');
  using seed = new DatabaseSync(path);
  seed.prepare(`INSERT INTO objectives (id, request, criteria, scope, constraints_text, permissions, budget, creator, state, created_at)
    VALUES ('goal', 'Goal', '[]', 'context', '', '{}', '{}', 'person', 'open', 'now')`).run();
  await db.updateTaskDefinition('objective', { objectiveId: 'goal' }, actor);
  await assert.rejects(db.reserveAttempt(input('named', 'objective')), /Objective-linked/);
  assert.equal((await db.reserveAttempt(input())).attempt.taskId, 'plain');
});

test('A16/A49/R08: stale, future and unreadable claims refuse reservation naming the claim', async t => {
  const { db, path, executor } = await fixture(t);
  await add(db, 'one');
  using sql = new DatabaseSync(path);
  for (const time of ['2000-01-01', '2999-01-01', 'unreadable']) {
    sql.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run(time, executor.claimId);
    const before = snapshot(db, path);
    await assert.rejects(db.reserveAttempt(input()), error => conflict(error) && String(error).includes(executor.claimId));
    assert.deepEqual(snapshot(db, path), before);
  }
});

test('R08/R09: a fresh executor permits other reservations, stale/released claimed work and all uncertainty block', async t => {
  for (const mode of ['fresh', 'stale', 'future', 'unreadable', 'released', 'uncertain'] as const) await t.test(mode, async t => {
    const { db, executor, path } = await fixture(t);
    await add(db, 'one'); await add(db, 'two');
    const first = await db.reserveAttempt(input('first', 'one'));
    const { effect } = await db.beginWorkspaceAcquisition(first.attempt.id, first.requestId, executor, actor);
    if (mode === 'stale' || mode === 'future' || mode === 'unreadable') {
      using sql = new DatabaseSync(path);
      const heartbeat = mode === 'stale' ? '2000-01-01' : mode === 'future' ? '2999-01-01' : 'unreadable';
      sql.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run(heartbeat, executor.claimId);
    } else if (mode === 'released') await db.releaseClaim(executor, { stopped: true }, actor);
    else if (mode === 'uncertain') await db.recordUncertainAcquisition(first.attempt.id, effect.id, executor, { reason: 'lost response' });
    if (mode === 'fresh') {
      assert.deepEqual(db.admissionBlockers(), []);
      assert.equal((await db.reserveAttempt(input('second', 'two'))).attempt.taskId, 'two');
    } else {
      assert.ok(db.admissionBlockers().some(blocker => blocker.kind === 'effect' && blocker.requestId === effect.id));
      await assert.rejects(db.reserveAttempt(input('second', 'two')), error => conflict(error) && String(error).includes(effect.id));
    }
  });
});

test('A10/R05: provider-chosen path is recorded once, identical allocations return it and differences refuse', async t => {
  const { db, executor, path } = await fixture(t);
  await add(db, 'one');
  const reserved = await db.reserveAttempt(input());
  const { effect, claimed } = await db.beginWorkspaceAcquisition(reserved.attempt.id, reserved.requestId, executor, actor);
  assert.equal(claimed, true);
  assert.equal(Object.hasOwn(effect.input.workspace as JsonObject, 'path'), false);
  const value = allocation(effect);
  assert.deepEqual(await db.recordAllocation(reserved.attempt.id, effect.id, executor, value), value);
  assert.deepEqual(db.attempt(reserved.attempt.id).allocation, value);
  const before = snapshot(db, path);
  assert.deepEqual(await db.recordAllocation(reserved.attempt.id, effect.id, executor, value), value);
  await assert.rejects(db.recordAllocation(reserved.attempt.id, effect.id, executor, { ...value, leaseId: 'another' }), conflict);
  await assert.rejects(db.recordAllocation(reserved.attempt.id, effect.id, executor, { ...value, path: join(value.pool, 'other') }), conflict);
  assert.deepEqual(snapshot(db, path), before);
  assert.equal(db.attempt(reserved.attempt.id).phase, 'allocated');
  assert.equal(db.request(effect.id).state, 'succeeded');
  assert.equal((await db.beginWorkspaceAcquisition(reserved.attempt.id, reserved.requestId, executor, actor)).claimed, false);
});

test('A11/R05: wrong provider holder, path, pool, repository, ref or commit never records an allocation', async t => {
  const changes = { holder: { taskId: 'another' }, path: resolve('another/path'), pool: resolve('another/pool'), repository: { identity: 'other' },
    outputRef: 'refs/heads/wrong', startingCommit: 'b'.repeat(40) };
  for (const [field, changed] of Object.entries(changes)) await t.test(field, async t => {
    const { db, executor } = await fixture(t);
    await add(db, 'one');
    let calls = 0;
    const provider = { acquire: async (request: { input: JsonObject }) => { calls++; return { ...allocation(request), [field]: changed }; } };
    await assert.rejects(reserveAndAllocate(db, input(), executor, provider), conflict);
    const replay = await reserveAndAllocate(db, input(), executor, provider);
    assert.equal(replay.attempt.allocation, null);
    assert.equal(replay.attempt.phase, 'needs_resolution');
    assert.equal(replay.attempt.leaseState, 'unknown');
    assert.equal(calls, 1);
    assert.equal(db.requests().find(request => request.category === 'effect')!.state, 'uncertain');
  });
});

test('A11/R05: provider paths must be absolute, normalised and strictly inside the recorded pool', async t => {
  const paths = {
    outside: (pool: string) => join(pool, '..', 'outside'),
    'sibling with pool prefix': (pool: string) => `${pool}-other${sep}workspace`,
    'equal to pool': (pool: string) => pool,
    'parent component': (pool: string) => `${pool}${sep}child${sep}..${sep}workspace`,
    relative: () => 'relative/workspace',
    'dot component': (pool: string) => `${pool}${sep}.${sep}workspace`,
    'trailing separator': (pool: string) => `${pool}${sep}workspace${sep}`,
  };
  for (const [name, providerPath] of Object.entries(paths)) await t.test(name, async t => {
    const { db, executor } = await fixture(t);
    await add(db, 'one');
    let calls = 0;
    const provider = { acquire: async (request: { input: JsonObject }) => {
      calls++;
      const value = allocation(request);
      return { ...value, path: providerPath(value.pool) };
    } };
    await assert.rejects(reserveAndAllocate(db, input(), executor, provider), error => conflict(error) || error instanceof TypeError);
    const replay = await reserveAndAllocate(db, input(), executor, provider);
    assert.equal(replay.attempt.allocation, null);
    assert.equal(replay.attempt.phase, 'needs_resolution');
    assert.equal(replay.attempt.leaseState, 'unknown');
    assert.equal(db.requests().find(request => request.category === 'effect')!.state, 'uncertain');
    assert.equal(calls, 1);
  });
});

test('R05/R09/R25: acquisition uses detached caller/executor identity and commits its claim before calling the provider', async t => {
  const { db, executor, path } = await fixture(t);
  await add(db, 'one');
  const command = { ...input(), caller: { ...actor } }, identity = { ...executor };
  let calls = 0;
  const pending = reserveAndAllocate(db, command, identity, { acquire: async request => {
    calls++;
    using observer = new DatabaseSync(path, { readOnly: true });
    const effect = observer.prepare('SELECT state, claim_id FROM requests WHERE id = ?').get(request.requestId)!;
    assert.equal(effect.state, 'claimed');
    assert.equal(effect.claim_id, executor.claimId);
    assert.equal(db.request(request.requestId).parentId, db.requests().find(value => value.category === 'command')!.id);
    return allocation(request);
  } });
  command.caller.id = 'changed';
  identity.generation = 'changed';
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.attempt.phase, 'allocated');
  assert.equal(db.requests().find(value => value.category === 'command')!.caller.id, actor.id);
});

test('A12/R05/R09: lost acquisition response retains path/holder/request evidence without lease and never acquires twice', async t => {
  const { db, executor } = await fixture(t);
  await add(db, 'one');
  let calls = 0;
  const provider = { acquire: async () => { calls++; throw new WorkspaceAcquisitionError('response lost', { path: '/pool/possible', holder: 'one' }); } };
  await assert.rejects(reserveAndAllocate(db, input(), executor, provider), /response lost/);
  const effect = db.requests().find(request => request.category === 'effect')!;
  assert.equal(effect.state, 'uncertain');
  assert.deepEqual(effect.result!.provider, { path: '/pool/possible', holder: 'one' });
  assert.equal(effect.result!.requestId, effect.id);
  assert.ok(effect.result!.request);
  const replay = await reserveAndAllocate(db, input(), executor, provider);
  assert.equal(calls, 1);
  assert.equal(replay.attempt.allocation, null);
  assert.equal(replay.attempt.leaseState, 'unknown');
  assert.equal((await db.beginWorkspaceAcquisition(replay.attempt.id, replay.requestId, executor, actor)).claimed, false);
});

test('A09/R25: failure inside every new transaction rolls back its state and every event', async t => {
  for (const operation of ['reserve', 'begin', 'allocate', 'uncertain']) for (const point of ['before-first', 'after-last']) await t.test(`${operation}, ${point}`, async t => {
    const { db, path, executor } = await fixture(t);
    await add(db, 'one');
    const reservation = operation === 'reserve' ? undefined : await db.reserveAttempt(input());
    const effect = ['allocate', 'uncertain'].includes(operation)
      ? (await db.beginWorkspaceAcquisition(reservation!.attempt.id, reservation!.requestId, executor, actor)).effect : undefined;
    const before = snapshot(db, path);
    const internal = db as unknown as { insertEvent: (event: EventInput) => StoredEvent };
    const original = internal.insertEvent;
    const eventCount = operation === 'allocate' || operation === 'uncertain' ? 2 : 1;
    let inserted = 0;
    internal.insertEvent = function (event) {
      if (point === 'before-first') throw new Error('injected transaction failure');
      const result = original.call(this, event);
      if (++inserted === eventCount) throw new Error('injected transaction failure');
      return result;
    };
    try {
      const change = operation === 'reserve' ? () => db.reserveAttempt(input()) : operation === 'begin'
        ? () => db.beginWorkspaceAcquisition(reservation!.attempt.id, reservation!.requestId, executor, actor)
        : operation === 'allocate' ? () => db.recordAllocation(reservation!.attempt.id, effect!.id, executor, allocation(effect!))
        : () => db.recordUncertainAcquisition(reservation!.attempt.id, effect!.id, executor, { reason: 'lost' });
      await assert.rejects(change(), /injected transaction failure/);
    } finally { internal.insertEvent = original; }
    assert.deepEqual(snapshot(db, path), before);
  });
});
