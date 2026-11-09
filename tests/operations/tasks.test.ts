import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, StoredEvent } from '../../src/storage/database.ts';
import type { AddTaskInput, TaskActor, TaskDefinition } from '../../src/storage/tasks.ts';

const person: TaskActor = { kind: 'person', id: 'operator' };
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-tasks-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, retryMs: 1000 };
  const db = await Database.initialise(path, { contextId: 'tasks', repository: { identity: 'example' },
    stateDirectory: root, createdBy: person,
    configuration: { revision: 1, resolved: { profiles: { worker: {}, other: {} } }, digest: 'test', provenance: {} } }, options);
  defer(t, () => db.close());
  return { db, path, options };
}

function ids(tasks: { id: string }[]): string[] { return tasks.map(task => task.id); }

function snapshot(db: Database) {
  return { tasks: db.tasks(), ready: db.readyTasks(), events: db.events() };
}

test('A03/R02: add at the end, generate readable collision-safe IDs, preserve IDs and ready order', async t => {
  const { db, path, options } = await fixture(t);
  const first = await db.addTask({ title: 'Café: build the API!' }, person);
  assert.equal(first.id, 'cafe-build-the-api');
  assert.deepEqual(first, { id: first.id, title: 'Café: build the API!', instructions: '', criteria: [],
    kind: 'code', reviewTarget: null, profile: null, objectiveId: null, position: 1, state: 'queued', holdReason: null,
    definitionRevision: 1, decisionRevision: 0, blockerIds: [] });
  await db.addTask({ id: 'cafe-build-the-api-2', title: 'Explicit ID' }, person);
  const third = await db.addTask({ title: 'Café: build the API!' }, person);
  assert.equal(third.id, 'cafe-build-the-api-3');
  await db.addTask({ id: 'dependent', title: 'Dependent', blockerIds: [first.id] }, person);
  await db.addTask({ title: '🎉' }, person);
  await db.addTask({ title: '🎉' }, person);
  assert.deepEqual(ids(db.readyTasks()), [first.id, 'cafe-build-the-api-2', third.id, 'task', 'task-2']);
  assert.deepEqual(db.tasks().map(task => task.position), [1, 2, 3, 4, 5, 6]);
  await db.markTaskDone(first.id, person);
  assert.deepEqual(ids(db.readyTasks()), ['cafe-build-the-api-2', third.id, 'dependent', 'task', 'task-2']);
  const before = snapshot(db);
  await assert.rejects(db.addTask({ id: first.id, title: 'Reuse done ID' }, person), conflict);
  await assert.rejects(db.addTask({ id: 'dependent', title: 'Reuse queued ID' }, person), conflict);
  assert.deepEqual(snapshot(db), before);
  const next = await db.addTask({ title: 'Café: build the API!' }, person);
  assert.equal(next.id, 'cafe-build-the-api-4');
  assert.equal(next.position, 7);
  using reopened = await Database.open(path, options);
  assert.deepEqual(snapshot(reopened), snapshot(db));
});

test('A03/R02/R25: self, missing and transitive cyclic blockers roll back, including a partially added task', async t => {
  const { db, path, options } = await fixture(t);
  for (const id of ['a', 'b', 'c', 'd']) await db.addTask({ id, title: id }, person);
  await db.addBlocker('b', 'a', person);
  await db.addBlocker('c', 'b', person);
  const before = snapshot(db);
  for (const [task, blocker] of [['a', 'a'], ['a', 'missing'], ['missing', 'a'], ['a', 'c'], ['b', 'c'], ['b', 'a']]) {
    await assert.rejects(db.addBlocker(task!, blocker!, person), conflict);
    using reopened = await Database.open(path, options);
    assert.deepEqual(snapshot(reopened), before);
  }
  for (const blockerIds of [['a', 'missing'], ['a', 'new']]) {
    await assert.rejects(db.addTask({ id: 'new', title: 'New', blockerIds }, person), conflict);
    assert.deepEqual(snapshot(db), before);
  }
  // Removing an absent edge is a no-op, not a revision change or new evidence.
  await db.removeBlocker('d', 'a', person);
  assert.deepEqual(snapshot(db), before);
  await assert.rejects(db.removeBlocker('d', 'missing', person), conflict);
  await db.removeBlocker('b', 'a', person);
  assert.deepEqual(ids(db.readyTasks()), ['a', 'b', 'd']);
  assert.equal(db.task('b').definitionRevision, 1);
  assert.equal(db.task('b').decisionRevision, 2);
});

test('R03/R25: dependency decisions record revisions and actor, and command replay never repeats a change', async t => {
  const { db } = await fixture(t);
  for (const id of ['a', 'b']) await db.addTask({ id, title: id }, person);
  const command = (operation: string) => ({ requestKey: operation, operation, caller: person,
    input: { taskId: 'a', blockerId: 'b' }, fingerprint: operation });
  const before = db.task('a');
  const blocked = await db.addBlocker('a', 'b', person, command('task.block'));
  assert.equal(blocked.decisionRevision, before.decisionRevision + 1);
  assert.equal(blocked.definitionRevision, before.definitionRevision);
  assert.deepEqual(blocked.blockerIds, ['b']);
  assert.deepEqual(await db.addBlocker('a', 'b', person, command('task.block')), blocked);
  const unblocked = await db.removeBlocker('a', 'b', person, command('task.unblock'));
  assert.equal(unblocked.decisionRevision, blocked.decisionRevision + 1);
  assert.equal(unblocked.definitionRevision, before.definitionRevision);
  assert.deepEqual(unblocked.blockerIds, []);
  const after = snapshot(db);
  assert.deepEqual(await db.removeBlocker('a', 'b', person, command('task.unblock')), unblocked);
  // Replaying the old add returns its original result without recreating the edge.
  assert.deepEqual(await db.addBlocker('a', 'b', person, command('task.block')), blocked);
  assert.deepEqual(snapshot(db), after);
  const actions = db.events().filter(e => e.kind === 'action.recorded' && ['task.block', 'task.unblock'].includes(String(e.payload.operation)));
  assert.equal(actions.length, 2);
  for (const [index, event] of actions.entries()) {
    assert.deepEqual(event.actor, person);
    assert.equal(event.payload.person, person.id);
    assert.deepEqual(event.payload.before, index === 0 ? before : blocked);
    assert.deepEqual(event.payload.after, index === 0 ? blocked : unblocked);
    assert.equal(event.payload.blockerId, 'b');
  }
});

test('A03/R02: reopening a done blocker changes future readiness, not started/done dependants', async t => {
  const { db, path } = await fixture(t);
  await db.addTask({ id: 'blocker', title: 'Blocker' }, person);
  for (const id of ['queued', 'started', 'finished']) {
    await db.addTask({ id, title: id, blockerIds: ['blocker'] }, person);
  }
  await db.markTaskDone('blocker', person);
  assert.deepEqual(ids(db.readyTasks()), ['queued', 'started', 'finished']);
  // Only an eventual start operation may set in_flight. Seed that state at the storage fixture boundary.
  using seed = new DatabaseSync(path);
  seed.prepare("UPDATE tasks SET state = 'in_flight' WHERE id = 'started'").run();
  await db.markTaskDone('finished', person);
  const started = db.task('started');
  const finished = db.task('finished');
  await db.reopenTask('blocker', person);
  assert.deepEqual(ids(db.readyTasks()), ['blocker']);
  assert.deepEqual(db.task('started'), started);
  assert.deepEqual(db.task('finished'), finished);
  await db.markTaskDone('blocker', person);
  await db.holdTask('queued', 'Waiting for a person', person);
  assert.deepEqual(db.readyTasks(), []);
  await db.releaseTask('queued', person);
  assert.deepEqual(ids(db.readyTasks()), ['queued']);
});

test('A03/R02/R25: reorder is a complete atomic permutation with positive unique positions and no revision changes', async t => {
  const { db } = await fixture(t);
  for (const id of ['a', 'b', 'c']) await db.addTask({ id, title: id }, person);
  await db.reorderTasks(['c', 'a', 'b'], person);
  assert.deepEqual(ids(db.readyTasks()), ['c', 'a', 'b']);
  assert.deepEqual(db.tasks().map(task => task.position), [1, 2, 3]);
  assert.ok(db.tasks().every(task => task.definitionRevision === 1 && task.decisionRevision === 0));
  const before = snapshot(db);
  await db.reorderTasks(['c', 'a', 'b'], person);
  assert.deepEqual(snapshot(db), before);
  await assert.rejects(db.reorderTasks(['a', 'b'], person), conflict);
  await assert.rejects(db.reorderTasks(['c', 'a', 'unknown'], person), conflict);
  await assert.rejects(db.reorderTasks(['a', 'a', 'c'], person), /Duplicate/);
  assert.deepEqual(snapshot(db), before);
  const added = await db.addTask({ title: 'Last' }, person);
  assert.equal(added.position, 4);
  assert.deepEqual(ids(db.readyTasks()), ['c', 'a', 'b', 'last']);
});

test('A04/R03: each definition field increments once; multiple fields once; ordered criteria matter; no-op has no event', async t => {
  const { db, path } = await fixture(t);
  // Objective operations are outside this task. Seed a valid referenced objective.
  using seed = new DatabaseSync(path);
  seed.prepare(`INSERT INTO objectives (id, request, criteria, scope, constraints_text, permissions, budget, creator, state, created_at)
    VALUES ('objective', 'Request', '[]', '', '', '{}', '{}', 'operator', 'open', '2026-11-08')`).run();
  await db.addTask({ id: 'a', title: 'Initial' }, person);
  const patches: Partial<TaskDefinition>[] = [{ title: 'Changed' }, { instructions: 'Instructions' },
    { criteria: ['First', 'Second'] }, { criteria: ['Second', 'First'] }, { kind: 'report' },
    { profile: 'worker' }, { objectiveId: 'objective' }, { profile: null }, { objectiveId: null },
    { title: 'Several', instructions: 'Together', criteria: ['One'], kind: 'code', profile: 'other', objectiveId: 'objective' }];
  let revision = 1;
  for (const patch of patches) {
    const count = db.events().length;
    const task = await db.updateTaskDefinition('a', patch, person);
    assert.equal(task.definitionRevision, ++revision);
    assert.equal(task.decisionRevision, 0);
    assert.equal(db.events().length, count + 1);
    const before = snapshot(db);
    await db.updateTaskDefinition('a', patch, person);
    await db.updateTaskDefinition('a', {}, person);
    assert.deepEqual(snapshot(db), before);
  }
  const before = snapshot(db);
  await assert.rejects(db.updateTaskDefinition('a', { objectiveId: 'missing' }, person), conflict);
  assert.deepEqual(snapshot(db), before);
});

test('A04/R03: effective holds, releases, done and reopen increment only decisionRevision, never accepted output', async t => {
  const { db } = await fixture(t);
  await db.addTask({ id: 'a', title: 'A' }, person);
  const operations = [
    () => db.holdTask('a', 'Waiting', person),
    () => db.holdTask('a', 'Different reason', person),
    () => db.releaseTask('a', person),
    () => db.markTaskDone('a', person),
    () => db.reopenTask('a', person),
  ];
  let revision = 0;
  for (const operation of operations) {
    const count = db.events().length;
    const task = await operation();
    assert.equal(task.decisionRevision, ++revision);
    assert.equal(task.definitionRevision, 1);
    assert.equal(db.events().length, count + 1);
    const before = snapshot(db);
    await operation();
    assert.deepEqual(snapshot(db), before);
  }
  // A person's done decision clears the hold; reopening does not restore it.
  await db.holdTask('a', 'Still held', person);
  await db.markTaskDone('a', person);
  await db.reopenTask('a', person);
  assert.equal(db.task('a').holdReason, null);
  assert.equal(db.task('a').state, 'queued');
  assert.deepEqual(ids(db.readyTasks()), ['a']);
  const doneEvents = db.events().filter(event => event.payload.operation === 'task.done');
  assert.ok(doneEvents.every(event => event.payload.judgement === 'person' && event.actor.kind === 'person'));
  assert.ok(db.events().every(event => !event.kind.startsWith('output.') && !event.kind.startsWith('attempt.')));
});

for (const reason of ['awaiting_acceptance', 'checks_failed']) {
  test(`R03: done clears ${reason} with one decision revision and explanatory event`, async t => {
    const { db } = await fixture(t);
    await db.addTask({ id: 'a', title: 'A' }, person);
    await db.holdTask('a', reason, person);
    const before = db.task('a');
    const count = db.events().length;
    const done = await db.markTaskDone('a', person);
    assert.deepEqual(done, { ...before, state: 'done', holdReason: null, decisionRevision: before.decisionRevision + 1 });
    assert.equal(db.events().length, count + 1);
    const event = db.events().at(-1)!;
    assert.equal(event.payload.operation, 'task.done');
    assert.equal(event.payload.judgement, 'person');
    assert.deepEqual(event.actor, person);
    assert.deepEqual(event.payload.before, before);
    assert.deepEqual(event.payload.after, done);
    await db.markTaskDone('a', person);
    assert.equal(db.events().length, count + 1);
    assert.deepEqual(db.task('a'), done);
    const reopened = await db.reopenTask('a', person);
    assert.equal(reopened.holdReason, null);
    assert.equal(reopened.state, 'queued');
    assert.equal(reopened.decisionRevision, done.decisionRevision + 1);
  });
}

test('R02/R25: strict task inputs and single-line bounded hold reasons refuse without changes', async t => {
  const { db } = await fixture(t);
  await db.addTask({ id: 'a', title: 'A' }, person);
  const before = snapshot(db);
  for (const value of [{ title: '' }, { title: 'A', state: 'in_flight' }, { title: 'A', definitionRevision: 20 },
    { title: 'A', kind: 'unknown' }, { title: 'A', criteria: [1] }, { title: 'A', blockerIds: ['a', 'a'] },
    { title: 'A', profile: '' }]) {
    await assert.rejects(db.addTask(value as AddTaskInput, person), TypeError);
  }
  for (const value of [{ state: 'in_flight' }, { position: 1 }, { title: undefined }, { criteria: [null] }]) {
    await assert.rejects(db.updateTaskDefinition('a', value as Partial<TaskDefinition>, person), TypeError);
  }
  for (const reason of ['', '  ', 'a\nb', 'a\rb', 'a\u2028b', 'x'.repeat(201)]) {
    await assert.rejects(db.holdTask('a', reason, person), TypeError);
  }
  await assert.rejects(db.addTask({ title: 'No authority' }, { kind: 'supervisor', id: 'worker' } as unknown as TaskActor), TypeError);
  assert.deepEqual(snapshot(db), before);
  await db.holdTask('a', 'x'.repeat(200), person);
  assert.equal(db.task('a').holdReason?.length, 200);
});

test('A09/A10/R25: every task write and its explanatory event roll back together on injected failure', async t => {
  const changes: [string, (db: Database) => Promise<unknown>, 'held' | 'done' | 'blocked' | undefined][] = [
    ['add', db => db.addTask({ id: 'new', title: 'New', blockerIds: ['a'] }, person), undefined],
    ['definition', db => db.updateTaskDefinition('a', { title: 'Changed', criteria: ['New'] }, person), undefined],
    ['block', db => db.addBlocker('b', 'a', person), undefined],
    ['unblock', db => db.removeBlocker('b', 'a', person), 'blocked'],
    ['reorder', db => db.reorderTasks(['c', 'b', 'a'], person), undefined],
    ['hold', db => db.holdTask('a', 'Waiting', person), undefined],
    ['release', db => db.releaseTask('a', person), 'held'],
    ['done', db => db.markTaskDone('a', person), undefined],
    ['reopen', db => db.reopenTask('a', person), 'done'],
  ];
  for (const [name, change, setup] of changes) {
    for (const afterEvent of [false, true]) {
      await t.test(`${name}: failure ${afterEvent ? 'after' : 'before'} event insertion`, async t => {
        const { db, path, options } = await fixture(t);
        for (const id of ['a', 'b', 'c']) await db.addTask({ id, title: id }, person);
        if (setup === 'blocked') await db.addBlocker('b', 'a', person);
        if (setup === 'held') await db.holdTask('a', 'Waiting', person);
        if (setup === 'done') await db.markTaskDone('a', person);
        const before = snapshot(db);
        // Private fault seam only: no arbitrary transaction or SQL API is exposed to operations.
        const internals = db as unknown as { insertEvent: (input: EventInput) => StoredEvent };
        const original = internals.insertEvent;
        let calls = 0;
        internals.insertEvent = function (input) {
          calls++;
          if (afterEvent) original.call(db, input);
          throw new Error('injected transaction failure');
        };
        try { await assert.rejects(change(db), /injected transaction failure/); }
        finally { internals.insertEvent = original; }
        assert.equal(calls, 1);
        using reopened = await Database.open(path, options);
        assert.deepEqual(snapshot(reopened), before);
        // The failed transaction also releases its write lock and leaves this connection usable.
        await change(db);
        assert.equal(db.events().length, before.events.length + 1);
      });
    }
  }
});

test('R25: concurrent stores serialise generated IDs, end positions, definition edits and cycle admission', async t => {
  const { db, path, options } = await fixture(t);
  using other = await Database.open(path, { ...options, readOnly: false });
  await Promise.all([db.addTask({ title: 'Same' }, person), other.addTask({ title: 'Same' }, person)]);
  assert.deepEqual(ids(db.tasks()), ['same', 'same-2']);
  await Promise.all([db.updateTaskDefinition('same', { title: 'Renamed' }, person),
    other.updateTaskDefinition('same', { instructions: 'Kept too' }, person)]);
  assert.equal(db.task('same').title, 'Renamed');
  assert.equal(db.task('same').instructions, 'Kept too');
  assert.equal(db.task('same').definitionRevision, 3);
  const results = await Promise.allSettled([db.addBlocker('same', 'same-2', person), other.addBlocker('same-2', 'same', person)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && conflict(result.reason)).length, 1);
});

test('R25: task inputs are detached before asynchronous lock admission', async t => {
  const { db, path } = await fixture(t);
  using locker = new DatabaseSync(path);
  locker.exec('BEGIN IMMEDIATE');
  const input = { title: 'Original', criteria: ['Original criterion'] };
  const actor: TaskActor = { kind: 'person', id: 'original-person' };
  const pending = db.addTask(input, actor);
  input.title = 'Mutated';
  input.criteria.push('Mutated');
  actor.id = 'mutated-person';
  locker.exec('COMMIT');
  const task = await pending;
  assert.equal(task.id, 'original');
  assert.equal(task.title, 'Original');
  assert.deepEqual(task.criteria, ['Original criterion']);
  assert.equal(db.events().at(-1)!.actor.id, 'original-person');

  locker.exec('BEGIN IMMEDIATE');
  const patch = { criteria: ['Updated criterion'] };
  const updating = db.updateTaskDefinition(task.id, patch, person);
  patch.criteria[0] = 'Mutated again';
  locker.exec('COMMIT');
  assert.deepEqual((await updating).criteria, ['Updated criterion']);
});

test('R25: read-only task inspection cannot mutate or record an event', async t => {
  const { db, path, options } = await fixture(t);
  await db.addTask({ id: 'a', title: 'A' }, person);
  using readonly = await Database.open(path, options);
  const before = snapshot(readonly);
  await assert.rejects(readonly.addTask({ title: 'No' }, person), error => error instanceof StorageError && error.code === 'read_only');
  await assert.rejects(readonly.markTaskDone('a', person), error => error instanceof StorageError && error.code === 'read_only');
  assert.deepEqual(snapshot(readonly), before);
});
