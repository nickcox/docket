import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defer } from '../helpers/cleanup.ts';
import { configuration } from '../fixtures/configuration.ts';
import { initialiseContext, openContext } from '../../src/context.ts';
import { createBinding } from '../../src/binding.ts';
import { CommandFailure } from '../../src/response.ts';
import { runCli } from '../../src/cli.ts';
import { executeCoreOperation } from '../../src/operations.ts';
import type { StoredEvent } from '../../src/storage/database.ts';

const person = { kind: 'person' as const, id: 'operator' };
const supervisor = { kind: 'supervisor' as const, id: 'supervisor', sessionId: 'session', objectiveId: 'goal' };
const host = { kind: 'host' as const, id: 'host' };
const invalid = (error: unknown) => error instanceof CommandFailure && error.code === 'invalid_input';

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-notifications-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json');
  await writeFile(file, JSON.stringify(configuration(home)));
  await initialiseContext({ config: file }, { home, recyclableRoots: [], caller: person });
  const context = await openContext({ config: file }, { home, readOnly: false });
  defer(t, () => context.database.close());
  const db = context.database;
  for (const id of ['goal', 'other']) await db.addObjective({ id, request: 'Build', criteria: ['Works'], scope: '', constraints: '',
    permissions: null, budget: null, deadline: null }, person);
  const bindHost = () => createBinding(host, { config: file }, { home });
  const bindSupervisor = () => createBinding(supervisor, { config: file }, { home });
  return { db, home, file, bindHost, bindSupervisor };
}

test('R22/A45: facts are ordered unique notifications, and duplicate host source keys roll back conflicting batches', async t => {
  const f = await fixture(t);
  await f.db.addTask({ id: 'work', title: 'Work', objectiveId: 'goal' }, person);
  const fact = { sourceKey: 'host:source:1', kind: 'worker.observed', payloadVersion: 1,
    correlationId: 'observation', actor: { kind: 'host' }, occurredAt: new Date().toISOString(), taskId: 'work', payload: { kind: 'turn_ended' } };
  const [first] = await f.db.appendEvents([fact]);
  assert.equal(first!.notification, true);
  assert.equal(first!.objectiveId, 'goal');
  await f.db.moveTask('work', f.db.task('work').definitionRevision, 'other', person);
  assert.deepEqual(await f.db.appendEvents([fact]), [first], 'A duplicate after task movement retains its original scope');
  const before = f.db.events();
  await assert.rejects(f.db.appendEvents([{ ...fact, sourceKey: 'new' }, { ...fact, payload: { kind: 'terminal' } }]));
  assert.deepEqual(f.db.events(), before, 'A conflicting fact rolls back the whole transaction');
  const events = f.db.notificationPage(0, 'goal');
  assert.ok(events.some(e => e.kind === 'action.recorded' && e.payload.operation === 'task.add'));
  assert.equal(events.filter(e => e.sourceKey === fact.sourceKey).length, 1);
  assert.deepEqual(events.map(e => e.seq), events.map(e => e.seq).toSorted((a, b) => a - b));
});

test('R22/A45: delivery, admission and handling are distinct; restart and lost admission acknowledgement reuse the batch', async t => {
  const f = await fixture(t);
  await f.db.addTask({ id: 'work', title: 'Work', objectiveId: 'goal' }, person);
  const before = f.db.events().length;
  const args = { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 };
  const batch = await f.bindHost().execute('supervisor.pending', args, 'poll-1');
  assert.equal(batch.admitted, false);
  assert.equal(batch.handledSequence, 0);
  assert.equal((batch.eventIds as string[]).length, 2);
  assert.equal(f.db.events().slice(before).filter(e => e.notification).length, 0, 'Delivery control does not recursively notify');
  await assert.rejects(f.bindSupervisor().execute('supervisor.handled', { eventIds: batch.eventIds }, 'premature'), invalid);
  await assert.rejects(f.bindHost().execute('supervisor.admitted', { objectiveId: 'goal', deliveryRequestId: batch.deliveryRequestId,
    eventIds: [...batch.eventIds as string[]].reverse() }, 'wrong-admission'), invalid);
  const admission = { objectiveId: 'goal', deliveryRequestId: batch.deliveryRequestId, eventIds: batch.eventIds };
  const admitted = await f.bindHost().execute('supervisor.admitted', admission, 'admission');
  assert.equal(admitted.handledSequence, 0);
  assert.deepEqual(await f.bindHost().execute('supervisor.admitted', admission, 'admission'), admitted);
  const recovered = await f.bindHost().execute('supervisor.pending', args, 'poll-2');
  assert.equal(recovered.deliveryRequestId, batch.deliveryRequestId);
  assert.equal(recovered.admitted, true, 'The host reads admission and need not add another conversation prompt');
  assert.equal((await f.bindHost().execute('supervisor.pending', args, 'poll-1')).admitted, true, 'Replaying the original poll also reads current admission');
  const ids = batch.eventIds as string[];
  await assert.rejects(f.bindSupervisor().execute('supervisor.handled', { eventIds: ids.slice(1) }, 'gap'), invalid);
  await assert.rejects(f.bindSupervisor().execute('supervisor.handled', { eventIds: ids.toReversed() }, 'reordered'), invalid);
  const handled = await f.bindSupervisor().execute('supervisor.handled', { eventIds: ids }, 'handled');
  assert.equal(handled.handledSequence, (batch.events as { sequence: number }[]).at(-1)!.sequence);
  assert.deepEqual(await f.bindSupervisor().execute('supervisor.handled', { eventIds: ids }, 'handled'), handled);
  assert.deepEqual((await f.bindHost().execute('supervisor.pending', args, 'poll-3')).eventIds, []);
  assert.deepEqual((await f.bindHost().execute('supervisor.pending', args, 'poll-1')).eventIds, []);
  assert.equal(f.db.events().filter(e => e.kind === 'supervisor.delivery').length, 1);
  assert.equal(f.db.requests().filter(r => r.category === 'effect').length, 0, 'Recovery never activates or messages workers');
});

test('R22/A45: concurrent polls reserve one batch and partial handling recovers only the remaining suffix', async t => {
  const f = await fixture(t);
  await f.db.addTask({ id: 'work', title: 'Work', objectiveId: 'goal' }, person);
  const args = { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 };
  const [first, second] = await Promise.all([
    f.bindHost().execute('supervisor.pending', args, 'concurrent-1'),
    f.bindHost().execute('supervisor.pending', args, 'concurrent-2'),
  ]);
  assert.equal(first.deliveryRequestId, second.deliveryRequestId);
  await f.bindHost().execute('supervisor.admitted', { objectiveId: 'goal', deliveryRequestId: first.deliveryRequestId, eventIds: first.eventIds }, 'admit');
  const ids = first.eventIds as string[];
  await f.bindSupervisor().execute('supervisor.handled', { eventIds: ids.slice(0, 1) }, 'partial');
  const remaining = await f.bindHost().execute('supervisor.pending', args, 'recover');
  assert.equal(remaining.admitted, true);
  assert.equal(remaining.deliveryRequestId, first.deliveryRequestId);
  assert.deepEqual(remaining.eventIds, ids.slice(1));
  await f.bindSupervisor().execute('supervisor.handled', { eventIds: remaining.eventIds }, 'finish');
  assert.deepEqual((await f.bindHost().execute('supervisor.pending', args, 'empty')).eventIds, []);
});

test('R22/A45: pending never loses an earlier fact to a cursor; foreign events and noncontiguous batches cannot advance handling', async t => {
  const f = await fixture(t);
  const h = f.bindHost(), s = f.bindSupervisor();
  const batch = await h.execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 99999, timeoutMs: 0 }, 'poll');
  assert.equal((batch.eventIds as string[]).length, 1);
  const foreign = f.db.notificationPage(0, 'other')[0]!;
  await assert.rejects(s.execute('supervisor.handled', { eventIds: [foreign.id] }, 'foreign'), invalid);
  await assert.rejects(h.execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }), invalid);
  await assert.rejects(s.execute('supervisor.pending', {}));
  await assert.rejects(h.execute('supervisor.handled', { objectiveId: 'goal', eventIds: batch.eventIds }));
  await assert.rejects(s.execute('supervisor.handled', { objectiveId: 'other', eventIds: batch.eventIds }), invalid);
});

test('R22/R27/A45/A51: compact bounded batches retain sequence order without embedding large fact evidence', async t => {
  const f = await fixture(t);
  const facts = Array.from({ length: 25 }, (_, i) => ({ sourceKey: `large:${i}`, kind: 'test.fact', objectiveId: 'goal',
    payloadVersion: 1, correlationId: 'large', actor: person, occurredAt: new Date().toISOString(), payload: { text: 'x'.repeat(65536) } }));
  await f.db.appendEvents(facts);
  const batch = await f.bindHost().execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }, 'poll');
  assert.equal((batch.eventIds as string[]).length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 256 * 1024);
  await f.bindHost().execute('supervisor.admitted', { objectiveId: 'goal', deliveryRequestId: batch.deliveryRequestId, eventIds: batch.eventIds }, 'admit');
  await f.bindSupervisor().execute('supervisor.handled', { eventIds: batch.eventIds }, 'handle');
  const next = await f.bindHost().execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }, 'next');
  assert.equal((next.eventIds as string[]).length, 6);
  assert.notEqual(next.deliveryRequestId, batch.deliveryRequestId);
});

test('R27/A51: a broken watch pipe ends with a diagnostic rather than another stdout write', async () => {
  let writes = 0;
  const errors: string[] = [];
  const exit = await runCli(['status', 'watch', '--context', 'test', '--stdin'], {
    readFile: async () => '', readStdin: async () => JSON.stringify({ afterSequence: 0, timeoutMs: 0 }),
    stdout: () => { writes++; throw new Error('EPIPE'); }, stderr: text => errors.push(text),
  }, async () => ({ events: [], sequence: 0 }));
  assert.equal(exit, 3);
  assert.equal(writes, 1);
  assert.deepEqual(errors, ['Unable to write the watch stream.\n']);
});

test('R27/A51: status.watch streams bounded NDJSON after a sequence, ends at timeout and never handles notifications', async t => {
  const f = await fixture(t);
  const sequence = f.db.events().at(-1)!.seq;
  const outputs: string[] = [], errors: string[] = [];
  let recorded: StoredEvent | undefined;
  const started = Date.now();
  const exit = await runCli(['status', 'watch', '--config', f.file, '--stdin', '--json'], {
    readFile: async () => '', readStdin: async () => JSON.stringify({ afterSequence: sequence, timeoutMs: 60 }),
    stdout: text => outputs.push(text), stderr: text => errors.push(text),
  }, async (operation, args, progress, selector, requestId) => {
    if (!recorded) [recorded] = await f.db.appendEvents([{ sourceKey: 'during-watch', kind: 'test.fact', payloadVersion: 1,
      correlationId: 'watch', actor: person, occurredAt: new Date().toISOString(), payload: {} }]);
    return executeCoreOperation(operation, args, progress, selector!, requestId, { home: f.home });
  });
  assert.equal(exit, 0);
  assert.ok(Date.now() - started >= 60);
  const lines = outputs.map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].sequence, recorded!.seq);
  assert.equal(lines[0].data.event.id, recorded!.id);
  assert.equal(lines[1].data.final, true);
  assert.equal(lines[1].sequence, recorded!.seq);
  assert.ok(outputs.every(line => line.endsWith('\n') && Buffer.byteLength(line) <= 256 * 1024));
  assert.deepEqual(errors, []);
  assert.equal(f.db.events().filter(e => e.kind === 'supervisor.handled').length, 0);
});
