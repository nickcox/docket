import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Database } from '../../src/storage/database.ts';
import type { EventInput, StoredEvent } from '../../src/storage/database.ts';
import type { CommandInput } from '../../src/storage/requests.ts';
import { CommandFailure } from '../../src/response.ts';
import { permissions, unlimitedBudget } from '../../src/storage/objectives.ts';
import type { TaskActor } from '../../src/storage/tasks.ts';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';

const creator: TaskActor = { kind: 'person', id: 'creator' };
const other: TaskActor = { kind: 'person', id: 'other' };
const supervisor: TaskActor = { kind: 'supervisor', id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
const definition = { criteria: ['Works'], scope: '', constraints: '', permissions: permissions({}), budget: unlimitedBudget, deadline: null };
const input = { ...definition, id: 'goal', request: 'Build it', permissions: null, budget: null };
const code = (expected: string) => (error: unknown) => error instanceof CommandFailure && error.code === expected;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-objectives-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const db = await Database.initialise(path, { contextId: 'objectives', repository: { identity: 'example' }, stateDirectory: root,
    createdBy: creator, configuration: { revision: 1, resolved: {}, digest: 'test', provenance: {} } },
  { location: { retainedRoot: root, recyclableRoots: [] } });
  t.after(() => db.close());
  return { db, path };
}

test('R18/A36: defaults, exact budget/deadline storage, creator-only protected changes and abandonment', async t => {
  const { db } = await fixture(t);
  const goal = await db.addObjective(input, creator);
  assert.equal(goal.state, 'open');
  assert.equal(goal.creator, creator.id);
  assert.deepEqual(goal.permissions, permissions({}));
  assert.deepEqual(goal.budget, unlimitedBudget);
  const budget = { maxCost: 1.25, currency: 'AUD', maxTokens: 100, maxWorkerTimeMs: 5000 };
  const changed = { ...definition, permissions: permissions({ dispatch: false }), budget, deadline: '2020-01-02T03:04:05+10:00' };
  const before = db.events();
  await assert.rejects(db.updateObjective('goal', 1, changed, other), code('creator_required'));
  await assert.rejects(db.closeOrReopenObjective('goal', 'abandon', 'Stop', other), code('creator_required'));
  await assert.rejects(db.closeOrReopenObjective('goal', 'abandon', 'Stop', supervisor), code('creator_required'));
  await assert.rejects(db.updateObjective('goal', 1, changed, supervisor), code('person_required'));
  assert.deepEqual(db.events(), before);
  const updated = await db.updateObjective('goal', 1, changed, creator);
  assert.deepEqual(updated.budget, budget);
  assert.equal(updated.deadline, changed.deadline);
  assert.equal(updated.permissions.dispatch, false);
  assert.equal(updated.permissions.integrate, true);
  await assert.rejects(db.updateObjective('goal', 1, changed, creator), code('task_changed'));
  const scoped = await db.updateObjective('goal', 2, { ...changed, scope: 'New scope' }, other);
  assert.equal(scoped.scope, 'New scope');
  assert.equal((await db.closeOrReopenObjective('goal', 'abandon', 'No longer needed', creator)).state, 'abandoned');
});

test('R18/A36: missing stored permissions default, unknown stored or supplied permissions refuse', async t => {
  const { db, path } = await fixture(t);
  await db.addObjective(input, creator);
  using seed = new DatabaseSync(path);
  seed.prepare('UPDATE objectives SET permissions = ?').run('{"dispatch":false}');
  assert.deepEqual(db.objective('goal', creator).permissions, permissions({ dispatch: false }));
  seed.prepare('UPDATE objectives SET permissions = ?').run('{"invented":true}');
  assert.throws(() => db.objective('goal', creator), TypeError);
  assert.throws(() => permissions({ invented: true }), TypeError);
  assert.throws(() => permissions({ dispatch: null }), TypeError);
});

test('R19/A38: reopening clears closure/statements, retains exact prior closure history and changes no tasks or attempts', async t => {
  const { db, path } = await fixture(t);
  await db.addObjective(input, creator);
  await db.addTask({ id: 'task', title: 'Work', objectiveId: 'goal' }, creator);
  using seed = new DatabaseSync(path);
  // Completion/evidence matching belongs to a later operation; seed its stored closure at the fixture boundary.
  const completion = [{ position: 1, statement: 'Works', references: [{ evidenceEventId: 'retained' }] }];
  seed.prepare("UPDATE objectives SET state = 'completed', completion = ?, closed_at = '2026-01-01T00:00:00Z'").run(JSON.stringify(completion));
  const tasks = db.tasks(), attempts = seed.prepare('SELECT * FROM attempts').all();
  const reopened = await db.closeOrReopenObjective('goal', 'reopen', 'More work', supervisor);
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.closedAt, null);
  assert.deepEqual(reopened.completion, []);
  const history = db.events().find(event => event.kind === 'objective.reopen')!;
  assert.deepEqual((history.payload.before as Record<string, unknown>).completion, completion);
  assert.equal((history.payload.before as Record<string, unknown>).closedAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(db.tasks(), tasks);
  assert.deepEqual(seed.prepare('SELECT * FROM attempts').all(), attempts);
  await db.closeOrReopenObjective('goal', 'abandon', 'Pause', creator);
  await db.updateObjective('goal', 3, { ...definition, permissions: permissions({ manageTasks: false }) }, creator);
  await assert.rejects(db.closeOrReopenObjective('goal', 'reopen', 'Again', supervisor), code('permission_denied'));
  await assert.rejects(db.closeOrReopenObjective('goal', 'reopen', 'Again', { ...supervisor, objectiveId: 'elsewhere' }), code('outside_objective'));
  await db.closeOrReopenObjective('goal', 'reopen', 'Again', creator);
  assert.equal(db.events().filter(event => event.kind === 'objective.reopen').length, 2);
});

test('R18: membership changes require open objectives, person authority and the exact task revision', async t => {
  const { db } = await fixture(t);
  await db.addObjective(input, creator);
  await db.addObjective({ ...input, id: 'other' }, creator);
  const task = await db.addTask({ id: 'task', title: 'Work', objectiveId: 'goal' }, creator);
  assert.equal(task.objectiveId, 'goal');
  await assert.rejects(db.moveTask('task', 1, null, supervisor), code('person_required'));
  await assert.rejects(db.moveTask('task', 0, null, creator), code('task_changed'));
  await db.closeOrReopenObjective('goal', 'abandon', 'Pause', creator);
  await assert.rejects(db.addTask({ title: 'No', objectiveId: 'goal' }, creator));
  await assert.rejects(db.moveTask('task', 1, null, creator));
  await db.closeOrReopenObjective('goal', 'reopen', 'Resume', creator);
  await db.closeOrReopenObjective('other', 'abandon', 'Pause', creator);
  await assert.rejects(db.moveTask('task', 1, 'other', creator));
  assert.equal(db.task('task').definitionRevision, 1);
  await db.closeOrReopenObjective('other', 'reopen', 'Resume', creator);
  const moved = await db.moveTask('task', 1, 'other', other);
  assert.equal(moved.objectiveId, 'other');
  assert.equal(moved.definitionRevision, 2);
  await assert.rejects(db.updateTaskDefinition('task', { objectiveId: null }, creator));
  assert.equal((await db.moveTask('task', 2, null, creator)).objectiveId, null);
});

test('R18/R19/R25: objective changes, membership, history and replay roll back together on the last event failure', async t => {
  const actions: [string, (db: Database, command: CommandInput) => Promise<unknown>][] = [
    ['objective.add', (db, command) => db.addObjective({ ...input, id: 'new' }, creator, command)],
    ['objective.update', (db, command) => db.updateObjective('goal', 1, { ...definition, criteria: ['Changed'] }, creator, command)],
    ['objective.abandon', (db, command) => db.closeOrReopenObjective('goal', 'abandon', 'Pause', creator, command)],
    ['objective.reopen', (db, command) => db.closeOrReopenObjective('goal', 'reopen', 'Resume', creator, command)],
    ['task.move', (db, command) => db.moveTask('task', 1, null, creator, command)],
  ];
  for (const [operation, change] of actions) await t.test(operation, async t => {
    const { db } = await fixture(t);
    await db.addObjective(input, creator);
    await db.addTask({ id: 'task', title: 'Work', objectiveId: 'goal' }, creator);
    if (operation === 'objective.reopen') await db.closeOrReopenObjective('goal', 'abandon', 'Pause', creator);
    const snapshot = () => ({ objectives: db.objectives(), tasks: db.tasks(), events: db.events(), requests: db.requests() });
    const before = snapshot();
    const internals = db as unknown as { insertEvent: (event: EventInput) => StoredEvent };
    const original = internals.insertEvent;
    internals.insertEvent = function (event) {
      const result = original.call(db, event);
      if (event.kind === 'request.succeeded') throw new Error('injected last-event failure');
      return result;
    };
    try {
      await assert.rejects(change(db, { operation, caller: creator, requestKey: operation, input: {}, fingerprint: 'fingerprint' }), /last-event failure/u);
    } finally { internals.insertEvent = original; }
    assert.deepEqual(snapshot(), before);
  });
});

test('R18/R28: invalid budgets, deadlines, criteria and unknown fields refuse without writes', async t => {
  const { db } = await fixture(t);
  for (const budget of [
    { ...unlimitedBudget, maxCost: -1 }, { ...unlimitedBudget, maxCost: 1 },
    { ...unlimitedBudget, maxTokens: 1.5 }, { ...unlimitedBudget, maxWorkerTimeMs: -1 },
    { ...unlimitedBudget, currency: '' }, { ...unlimitedBudget, invented: 1 },
  ]) await assert.rejects(db.addObjective({ ...input, budget }, creator), TypeError);
  for (const deadline of ['2026-01-01', '2026-01-01T01:00:00', 'bad', '2026-13-01T01:00:00Z', '2026-02-30T01:00:00Z']) {
    await assert.rejects(db.addObjective({ ...input, deadline }, creator), TypeError);
  }
  for (const criteria of [[''], ['multiple\nlines'], ['x'.repeat(2049)]]) await assert.rejects(db.addObjective({ ...input, criteria }, creator), TypeError);
  assert.deepEqual(db.objectives(), []);
  const schema = findOperation('objective.add')!.inputSchema;
  assert.equal(validateSchema(schema, input), null);
  assert.notEqual(validateSchema(schema, { ...input, permissions: { invented: true } }), null);
  assert.notEqual(validateSchema(schema, { ...input, budget: { ...unlimitedBudget, maxCost: '1' } }), null);
  assert.notEqual(validateSchema(schema, { ...input, caller: creator }), null);
  assert.notEqual(validateSchema(schema, { ...input, dryRun: true }), null, 'R30: these contracts do not take dryRun');
});
