import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Database, StorageError } from '../../src/storage/database.ts';
import type { WorkerHost } from '../../src/storage/launch.ts';

const person = { kind: 'person' as const, id: 'operator' };
const host: WorkerHost = { kind: 'host', id: 'backend', generation: 'generation-1' };
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, readOnly: false, retryMs: 1000 };
  const db = await Database.initialise(path, { contextId: 'launch', repository: { identity: 'example' },
    stateDirectory: root, createdBy: person,
    configuration: { revision: 1, resolved: {}, digest: 'test', provenance: {} } }, options);
  t.after(() => db.close());
  return { db, path, options };
}

async function allocated(db: Database, path: string, taskId: string, revision = 1) {
  await db.addTask({ id: taskId, title: taskId }, person);
  const attemptId = randomUUID();
  using seed = new DatabaseSync(path);
  seed.prepare(`INSERT INTO attempts (id, task_id, number, phase, specification, output_ref,
    lease_id, allocation, lease_state, created_at) VALUES (?, ?, 1, 'allocated', ?, ?, ?, ?, 'held', ?)`)
    .run(attemptId, taskId, JSON.stringify({ definitionRevision: revision }), `refs/docket/${attemptId}`,
      `lease-${attemptId}`, JSON.stringify({ leaseId: `lease-${attemptId}` }), new Date().toISOString());
  const claimId = await db.registerWorkerOwner(attemptId, host);
  assert.equal(await db.registerWorkerOwner(attemptId, host), claimId);
  await db.heartbeatWorkerOwner(attemptId, claimId, host);
  return { attemptId, claimId };
}

function rows(path: string, attemptId: string) {
  using read = new DatabaseSync(path, { readOnly: true });
  return {
    attempt: read.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId)!,
    effects: read.prepare("SELECT * FROM requests WHERE attempt_id = ? AND operation = 'worker.activate'").all(attemptId),
  };
}

test('R06/R25: binding precedes one permitted bb prompt and replay never re-admits it', async t => {
  const { db, path, options } = await fixture(t);
  const { attemptId, claimId } = await allocated(db, path, 'first');
  const reference = { launcher: 'bb' as const, threadId: 'thr_first' };
  assert.deepEqual(await db.admitInitialBbPrompt(attemptId, reference.threadId, host), { kind: 'pending' });
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'permit', host), conflict);
  assert.deepEqual(await db.bindWorkerReference(attemptId, claimId, reference, host), reference);
  assert.deepEqual(await db.bindWorkerReference(attemptId, claimId, reference, host), reference);
  assert.deepEqual(await db.admitInitialBbPrompt(attemptId, reference.threadId, host), { kind: 'pending' });
  await assert.rejects(db.bindWorkerReference(attemptId, claimId, { launcher: 'bb', threadId: 'thr_other' }, host), conflict);
  const decision = await db.decideWorkerLaunch(attemptId, claimId, 'permit', host);
  assert.equal(decision.state, 'permitted');
  assert.equal(decision.changed, true);
  assert.ok(decision.effectId);
  assert.deepEqual(await db.decideWorkerLaunch(attemptId, claimId, 'permit', host), { ...decision, changed: false });
  assert.equal(await db.registerWorkerOwner(attemptId, host), claimId);
  await assert.rejects(db.admitInitialBbPrompt(attemptId, 'thr_other', host), conflict);
  using peer = await Database.open(path, options);
  const [first, second] = await Promise.all([
    db.admitInitialBbPrompt(attemptId, reference.threadId, host),
    peer.admitInitialBbPrompt(attemptId, reference.threadId, host),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ['admitted', 'already_admitted']);
  assert.deepEqual(await peer.admitInitialBbPrompt(attemptId, reference.threadId, host), { kind: 'already_admitted' });
  const state = rows(path, attemptId);
  assert.equal(state.attempt.launch_state, 'permitted');
  assert.equal(state.attempt.phase, 'running');
  assert.equal(state.attempt.started_decision_revision, 0);
  assert.equal(state.effects.length, 1);
  assert.equal(state.effects[0]!.state, 'claimed');
  assert.equal(db.task('first').state, 'in_flight');
  assert.deepEqual(db.events().filter(event => event.attemptId === attemptId).map(event => event.kind),
    ['attempt.owner_registered', 'attempt.worker_bound', 'attempt.launch_permitted', 'attempt.prompt_admitted']);
});

test('R06/R25: a fence and permission race has one irreversible winner', async t => {
  const { db, path, options } = await fixture(t);
  const { attemptId, claimId } = await allocated(db, path, 'race');
  await db.bindWorkerReference(attemptId, claimId, { launcher: 'bb', threadId: 'thr_race' }, host);
  using peer = await Database.open(path, options);
  const outcomes = await Promise.allSettled([
    db.decideWorkerLaunch(attemptId, claimId, 'permit', host),
    peer.decideWorkerLaunch(attemptId, claimId, 'fence', host),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && conflict(outcome.reason)).length, 1);
  const state = rows(path, attemptId);
  if (state.attempt.launch_state === 'permitted') {
    assert.equal(state.effects.length, 1);
    assert.equal(db.task('race').state, 'in_flight');
    assert.equal((await db.admitInitialBbPrompt(attemptId, 'thr_race', host)).kind, 'admitted');
  } else {
    assert.equal(state.attempt.launch_state, 'fenced');
    assert.equal(state.effects.length, 0);
    assert.equal(db.task('race').state, 'queued');
    assert.deepEqual(await db.admitInitialBbPrompt(attemptId, 'thr_race', host), { kind: 'fenced' });
  }
});

test('R03/R06/R25: changed task definition and stale owner claim refuse permission without partial writes', async t => {
  const { db, path } = await fixture(t);
  const { attemptId, claimId } = await allocated(db, path, 'stale');
  await db.bindWorkerReference(attemptId, claimId, { launcher: 'bb', threadId: 'thr_stale' }, host);
  await assert.rejects(db.registerWorkerOwner(attemptId, { ...host, generation: 'other-generation' }), conflict);
  const before = rows(path, attemptId);
  await db.updateTaskDefinition('stale', { title: 'Changed' }, person);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'permit', host), conflict);
  assert.equal(rows(path, attemptId).attempt.launch_state, before.attempt.launch_state);
  assert.equal(rows(path, attemptId).effects.length, 0);
  assert.equal(db.task('stale').state, 'queued');
  using seed = new DatabaseSync(path);
  seed.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', claimId);
  await assert.rejects(db.heartbeatWorkerOwner(attemptId, claimId, host), conflict);
  await assert.rejects(db.registerWorkerOwner(attemptId, host), conflict);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'fence', host), conflict);
  assert.equal(rows(path, attemptId).attempt.launch_state, 'pending');
});

test('R06/R25: evidence conflict rolls back reference and owner binding', async t => {
  const { db, path } = await fixture(t);
  const { attemptId, claimId } = await allocated(db, path, 'rollback');
  await db.appendEvents([{ sourceKey: `attempt.worker_bound:${attemptId}`, kind: 'test.conflict', payloadVersion: 1,
    correlationId: attemptId, actor: person, occurredAt: new Date().toISOString(), payload: {} }]);
  await assert.rejects(db.bindWorkerReference(attemptId, claimId, { launcher: 'bb', threadId: 'thr_rollback' }, host), conflict);
  const state = rows(path, attemptId);
  assert.equal(state.attempt.runtime_ref, null);
  assert.equal(state.attempt.owner_claim_id, null);
});

test('R06/R25: permit and prompt admission roll back if their evidence cannot be recorded', async t => {
  const { db, path } = await fixture(t);
  const { attemptId, claimId } = await allocated(db, path, 'evidence');
  await db.bindWorkerReference(attemptId, claimId, { launcher: 'bb', threadId: 'thr_evidence' }, host);
  await db.appendEvents([{ sourceKey: `attempt.launch_permitted:${attemptId}`, kind: 'test.conflict', payloadVersion: 1,
    correlationId: attemptId, actor: person, occurredAt: new Date().toISOString(), payload: {} }]);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'permit', host), conflict);
  assert.equal(rows(path, attemptId).attempt.launch_state, 'pending');
  assert.equal(rows(path, attemptId).effects.length, 0);
  assert.equal(db.task('evidence').state, 'queued');

  // A second allocated attempt exercises the later admission transaction.
  const next = await allocated(db, path, 'admission');
  await db.bindWorkerReference(next.attemptId, next.claimId, { launcher: 'bb', threadId: 'thr_admission' }, host);
  await db.decideWorkerLaunch(next.attemptId, next.claimId, 'permit', host);
  await db.appendEvents([{ sourceKey: `attempt.prompt_admitted:${next.attemptId}`, kind: 'test.conflict', payloadVersion: 1,
    correlationId: next.attemptId, actor: person, occurredAt: new Date().toISOString(), payload: {} }]);
  await assert.rejects(db.admitInitialBbPrompt(next.attemptId, 'thr_admission', host), conflict);
  assert.equal(rows(path, next.attemptId).effects[0]!.state, 'pending');
});


test('R06/R25: one bb thread cannot be bound to two attempts', async t => {
  const { db, path } = await fixture(t);
  const first = await allocated(db, path, 'one');
  const second = await allocated(db, path, 'two');
  await db.bindWorkerReference(first.attemptId, first.claimId, { launcher: 'bb', threadId: 'thr_shared' }, host);
  await assert.rejects(db.bindWorkerReference(second.attemptId, second.claimId,
    { launcher: 'bb', threadId: 'thr_shared' }, host), conflict);
  assert.equal(rows(path, second.attemptId).attempt.runtime_ref, null);
});
