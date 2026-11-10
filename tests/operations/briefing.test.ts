import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initialiseContext, openContext } from '../../src/context.ts';
import { createBinding } from '../../src/binding.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { applicationId } from '../../src/storage/database.ts';
import type { JsonObject } from '../../src/storage/database.ts';
import { configuration } from '../fixtures/configuration.ts';

const person = { kind: 'person' as const, id: 'operator' };
const supervisor = { kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
const host = { kind: 'host' as const, id: 'host' };
const hash = 'a'.repeat(40);
async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-briefing-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json');
  const config = configuration(home);
  config.limits = { maxAttempts: 20, maxAttemptsPerTask: 20, maxConcurrentFullChecks: 1 };
  await writeFile(file, JSON.stringify(config));
  await initialiseContext({ config: file }, { home, recyclableRoots: [], caller: person });
  const context = await openContext({ config: file }, { home, readOnly: false });
  const db = context.database;
  defer(t, () => db.close());
  const binding = createBinding(person, { config: file }, { home });
  const agent = createBinding(supervisor, { config: file }, { home });
  const hostBinding = createBinding(host, { config: file }, { home });
  for (const id of ['goal', 'other']) await binding.execute('objective.add', { id, request: 'Deliver a reliable project',
    criteria: ['All features work', 'Evidence retained'], scope: 'Project', constraints: 'No publication', permissions: null, budget: null, deadline: null });
  const add = (id: string) => binding.execute('task.add', { id, objectiveId: 'goal', definition: {
    title: `Implement ${id}`, instructions: 'Long task instructions. '.repeat(500), criteria: [`${id} criterion one`, `${id} criterion two`], kind: 'code', profile: null } });
  const register = () => db.registerSession({ sessionId: 'session', kind: 'supervisor', objectiveId: 'goal', attemptId: null,
    registeredAt: new Date().toISOString(), capabilities: [] }, host);
  return { db, binding, agent, hostBinding, add, register };
}

test('R23/A46: canonical three-task/thirteen-attempt briefing preserves blockers under 15,000 characters and full detail stays available', async t => {
  const f = await fixture(t);
  for (const id of ['one', 'two', 'three']) await f.add(id);
  await f.register();
  // Reserve real immutable specifications; seed terminal owner/result facts at the fixture boundary.
  using sql = new DatabaseSync(f.db.path);
  for (let i = 0; i < 13; i++) {
    const taskId = ['one', 'two', 'three'][i % 3]!;
    const reserved = await f.db.reserveAttempt({ requestKey: `dispatch-${i}`, taskId, caller: supervisor, startingCommit: hash,
      checks: { sourceCommit: hash, digest: 'policy', fast: [], full: [] }, delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
    const id = reserved.attempt.id, candidateId = randomUUID();
    await f.db.registerSession({ sessionId: `worker-${i}`, kind: 'worker', objectiveId: 'goal', attemptId: id,
      registeredAt: new Date().toISOString(), capabilities: [] }, host);
    await f.db.appendEvents([{ sourceKey: `finished-${i}`, kind: 'session.finished', payloadVersion: 1,
      correlationId: id, attemptId: id, objectiveId: 'goal', actor: host, occurredAt: new Date().toISOString(), payload: { sessionId: `worker-${i}` } }]);
    sql.prepare("UPDATE attempts SET execution_open = 0, phase = 'settled', outcome = 'completed', candidate = ? WHERE id = ?")
      .run(JSON.stringify({ id: candidateId, commit: hash, outputRef: reserved.attempt.specification.outputRef }), id);
    const event = { sourceKey: `attempt.result_validated:${id}`, kind: 'attempt.result_validated', payloadVersion: 1,
      correlationId: id, attemptId: id, taskId, actor: host, occurredAt: new Date().toISOString(),
      payload: { content: { summary: `Attempt ${i + 1} implemented its change; remaining risk is exact-commit review.`, evidence: [{ name: 'full output', summary: 'Detailed output. '.repeat(500) }] },
        digest: 'digest', relativePath: 'result.json', validationVersion: 1, validatedAt: new Date().toISOString(), artefacts: [] } };
    await f.db.appendEvents([event]);
    if (i < 3) await f.db.appendEvents([{ sourceKey: `review-${i}`, kind: 'review.recorded', payloadVersion: 1,
      correlationId: id, attemptId: id, taskId, actor: host, occurredAt: new Date().toISOString(),
      payload: { sourceAttemptId: id, reviewAttemptId: randomUUID(), candidateId, commit: hash, criteria: f.db.task(taskId).criteria,
        verdict: i === 2 ? 'failed' : 'passed', findings: f.db.task(taskId).criteria.map((criterion, index) => ({ position: index + 1, criterion,
          status: i === 2 ? 'not_met' : 'met', evidence: i === 2 ? 'Boundary condition still fails; repair before acceptance.' : 'Focused tests confirm the criterion.' })) } }]);
    const command = await f.db.recordCommand({ requestKey: `check-${i}`, operation: 'checks.run', caller: supervisor,
      input: { attemptId: id, commit: hash }, fingerprint: `check-${i}` });
    sql.prepare("UPDATE requests SET attempt_id = ?, state = 'succeeded', result = ? WHERE id = ?").run(id, JSON.stringify({ status: i === 12 ? 'failed' : 'passed', output: 'Full check output. '.repeat(500) }), command.id);
  }
  await f.db.registerClaims([{ resourceKey: 'supervisor:goal', role: 'supervisor', objectiveId: 'goal', generation: 'generation',
    ownerRef: host, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: '2020-01-01T00:00:00Z' }], person);
  await f.agent.execute('supervisor.note', { text: 'Keep the failed check visible and obtain independent review.' }, 'note');
  await f.agent.execute('question.ask', { text: 'Which behaviour is intended?', choices: ['A', 'B'], waiting: true }, 'question');
  const first = await f.agent.execute('supervisor.briefing', {});
  const briefing = first.briefing as any;
  assert.equal(briefing.tasks.length, 3);
  assert.equal(briefing.attempts.length, 13);
  t.diagnostic(`Canonical briefing: ${JSON.stringify(first).length} characters`);
  assert.ok(JSON.stringify(first).length <= 15000, `Briefing length: ${JSON.stringify(first).length}`);
  for (const id of ['one', 'two', 'three']) assert.equal(JSON.stringify(first).split(`${id} criterion one`).length - 1, 1);
  assert.ok(briefing.attempts[12].waitingFor.includes('checks: failed'));
  assert.ok(briefing.attempts[12].waitingFor.includes('review: missing'));
  assert.equal(briefing.attempts[2].reviews[0].verdict, 'failed');
  assert.ok(briefing.attempts[2].waitingFor.includes('review: failed'));
  assert.equal(briefing.usage.gaps.length, 14);
  assert.equal(briefing.questions[0].text, 'Which behaviour is intended?');
  assert.equal(briefing.notes.length, 1);
  const pending = f.db.events().filter(e => e.objectiveId === 'goal' && e.notification);
  assert.equal(briefing.pendingEvents.count, pending.length);
  assert.equal(Object.values(briefing.pendingEvents.counts).reduce((sum: number, count) => sum + Number(count), 0), pending.length);
  assert.equal(briefing.pendingEvents.counts['attempt.reserved'], 13);
  assert.equal(briefing.pendingEvents.detailOperation, 'supervisor.pending');
  assert.deepEqual(briefing.pendingEvents.recent, pending.slice(-3).map(e => ({ id: e.id, sequence: e.seq, kind: e.kind, attemptId: e.attemptId ?? null })));
  assert.equal(briefing.authority[0].kind, 'unrestricted');
  assert.equal(briefing.ownerDiagnostics.claims.length, 1);
  assert.equal(briefing.ownerDiagnostics.blockers[0].reason, 'stale');
  assert.equal(briefing.personActions.count, 4);
  assert.deepEqual(await f.agent.execute('supervisor.briefing', {}), first, 'Repeated reads add no state');
  const detail = await f.agent.execute('attempt.show', { attemptId: briefing.attempts[0].id }) as any;
  assert.match(detail.specification.task.instructions, /Long task instructions/u);
  assert.ok(detail.result.content.evidence[0].summary.length > 5000);
  assert.ok(detail.checks[0].result.output.length > 5000);
});

test('R23/A46: compact pending counts cover the full backlog and follow durable partial handling, not delivery admission', async t => {
  const f = await fixture(t);
  await f.register();
  for (let i = 0; i < 30; i++) await f.agent.execute('supervisor.note', { text: `Note ${i}` });
  await f.binding.execute('supervisor.note', { objectiveId: 'other', text: 'Foreign note' });
  const read = async () => (await f.agent.execute('supervisor.briefing', {})).briefing as any;
  const before = await read();
  assert.equal(before.pendingEvents.counts['supervisor.note'], 30);
  assert.equal(before.notes.length, 30);
  assert.equal(before.pendingEvents.recent.length, 3);
  const delivery = await f.hostBinding.execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }, 'pending');
  assert.equal((delivery.eventIds as string[]).length, 20, 'Full backlog counts are not limited to one delivery page');
  await f.hostBinding.execute('supervisor.admitted', { objectiveId: 'goal', deliveryRequestId: delivery.deliveryRequestId, eventIds: delivery.eventIds }, 'admitted');
  assert.deepEqual((await read()).pendingEvents, before.pendingEvents, 'Admission alone does not handle notifications');
  const handledIds = (delivery.eventIds as string[]).slice(0, 2);
  const handled = await f.agent.execute('supervisor.handled', { eventIds: handledIds });
  const after = await read();
  const pending = f.db.events().filter(e => e.objectiveId === 'goal' && e.notification && e.seq > Number(handled.handledSequence));
  assert.equal(after.pendingEvents.handledSequence, handled.handledSequence);
  assert.equal(after.pendingEvents.count, before.pendingEvents.count - 2);
  assert.equal(after.pendingEvents.count, pending.length);
  for (const kind of Object.keys(after.pendingEvents.counts)) {
    assert.equal(after.pendingEvents.counts[kind], pending.filter(e => e.kind === kind).length);
  }
  assert.deepEqual(after.pendingEvents.recent, before.pendingEvents.recent);
  const remaining = await f.hostBinding.execute('supervisor.pending', { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 }, 'remaining');
  assert.deepEqual(remaining.eventIds, (delivery.eventIds as string[]).slice(2), 'Full detail still starts at the oldest unhandled notification');
});

test('R23/A47: classifications and membership are write-once, with answer and return exceptions and replay deduplication', async t => {
  const f = await fixture(t);
  await f.add('one');
  const setup = f.db.events().filter(e => e.kind === 'person.action');
  assert.equal(f.db.personActions('goal').counts.setup, 2);
  await f.register();
  await f.binding.execute('task.hold', { taskId: 'one', reason: 'Inspect' }, 'hold');
  await f.binding.execute('task.hold', { taskId: 'one', reason: 'Inspect' }, 'hold');
  assert.equal(f.db.personActions('goal').counts.intervention, 1);
  const beforeFailure = f.db.events();
  await assert.rejects(f.binding.execute('task.hold', { taskId: 'one', reason: 'Different' }, 'hold'));
  assert.deepEqual(f.db.events(), beforeFailure);
  const question = (await f.agent.execute('question.ask', { text: 'Person decision?', choices: null, waiting: true })).question as any;
  await f.binding.execute('objective.abandon', { objectiveId: 'goal', reason: 'Pause' }, 'close');
  await f.binding.execute('question.answer', { questionId: question.id, text: 'Proceed' }, 'answer');
  await f.binding.execute('question.answer', { questionId: question.id, text: 'Proceed' }, 'answer-again');
  assert.equal(f.db.personActions('goal').counts.intervention, 3, 'Hold, close and person-addressed answer, once each');
  await f.binding.execute('supervisor.note', { objectiveId: 'goal', text: 'Retained after closure' }, 'cleanup');
  const history = f.db.events().filter(e => e.kind === 'person.action');
  assert.equal(f.db.personActions('goal').counts['clean-up'], 1);
  await f.binding.execute('objective.reopen', { objectiveId: 'goal', reason: 'Resume' }, 'reopen');
  await f.binding.execute('task.move', { taskId: 'one', expectedRevision: f.db.task('one').definitionRevision, objectiveId: 'other' }, 'move');
  for (const event of [...setup, ...history]) assert.deepEqual(f.db.events().find(e => e.id === event.id), event);
  const move = f.db.events().filter(e => e.kind === 'person.action' && e.payload.requestKey === 'move');
  assert.equal(move.length, 1, 'A move is one logical action, with both objective memberships captured');
  const scopes = move[0]!.payload.scopes as JsonObject[];
  assert.deepEqual(scopes.find(s => s.objectiveId === 'goal')!.members, ['one']);
  assert.deepEqual(scopes.find(s => s.objectiveId === 'other')!.members, []);
  await f.db.registerSession({ sessionId: 'other-session', kind: 'supervisor', objectiveId: 'other', attemptId: null,
    registeredAt: new Date().toISOString(), capabilities: [] }, host);
  const input: JsonObject = { taskId: 'one' };
  await f.db.recordCommand({ requestKey: 'return', operation: 'attempt.return', caller: person, input, fingerprint: canonicalJson(input) });
  assert.equal(f.db.personActions('other').recent[0]!.payload.classification, 'clean-up');
  await f.db.recordCommand({ requestKey: 'accept', operation: 'attempt.accept', caller: person, input, fingerprint: canonicalJson(input) });
  assert.equal(f.db.personActions('other').recent[0]!.payload.classification, 'intervention', 'An acceptance decision is not classified as a pure return');
  const count = f.db.personActions('other').count;
  const automatic = { ...input, automatic: true };
  await f.db.recordCommand({ requestKey: 'automatic-return', operation: 'attempt.return', caller: person, input: automatic, fingerprint: canonicalJson(automatic) });
  assert.equal(f.db.personActions('other').count, count, 'Automatic return does not add another person action');
  const objective = (await f.binding.execute('objective.show', { objectiveId: 'goal' })).objective as any;
  const briefing = (await f.binding.execute('supervisor.briefing', { objectiveId: 'goal' })).briefing as any;
  assert.deepEqual(objective.personActions, briefing.personActions);
  assert.equal(briefing.personActions.recent.length, 3);
});

test('R23/A47: a pre-supervisor return is setup but a person-addressed answer is always an intervention', async t => {
  const f = await fixture(t);
  await f.add('one');
  const input: JsonObject = { taskId: 'one' };
  await f.db.recordCommand({ requestKey: 'setup-return', operation: 'attempt.return', caller: person, input, fingerprint: canonicalJson(input) });
  assert.equal(f.db.personActions('goal').recent[0]!.payload.classification, 'setup');
  const question = (await f.agent.execute('question.ask', { text: 'Decision before supervision?', choices: null, waiting: true })).question as any;
  await f.binding.execute('question.answer', { questionId: question.id, text: 'Continue' });
  assert.equal(f.db.personActions('goal').recent[0]!.payload.classification, 'intervention');
});

test('R23/R28/R30: briefing and notes are strict, scoped, non-planable operations; notes replay without duplication', async t => {
  const f = await fixture(t);
  await assert.rejects(f.agent.execute('supervisor.briefing', { objectiveId: 'other' }), { code: 'invalid_input' });
  await assert.rejects(f.agent.execute('supervisor.note', { text: ' ' }), { code: 'invalid_input' });
  await assert.rejects(f.agent.execute('supervisor.note', { text: 'Note', dryRun: true }), { code: 'invalid_input' });
  const note = await f.agent.execute('supervisor.note', { text: 'Note' }, 'note');
  assert.deepEqual(await f.agent.execute('supervisor.note', { text: 'Note' }, 'note'), note);
  await assert.rejects(f.agent.execute('supervisor.note', { text: 'Changed' }, 'note'), { code: 'request_input_mismatch' });
  assert.equal(f.db.events().filter(e => e.kind === 'supervisor.note').length, 1);
  assert.throws(() => f.db.supervisorBriefing('other', supervisor), { code: 'outside_objective' });
  assert.equal(f.db.personActions('goal').count, 1, 'Supervisor notes are not person actions');
});
