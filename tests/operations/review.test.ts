import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../../src/configuration.ts';
import { applicationId } from '../../src/storage/database.ts';
import type { JsonObject } from '../../src/storage/database.ts';
import type { Allocation } from '../../src/storage/reservations.ts';
import type { WorkerReference } from '../../src/storage/launch.ts';
import { readWorkerResult } from '../../src/storage/results.ts';
import { prepareWorker } from '../../src/workers.ts';
import { piWorkerPrompt } from '../../src/adapters/pi.ts';
import { checkFixture, person, host, retention, head, start, contextChecks } from '../helpers/check-attempt.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { rejected } from '../../src/adapters/command.ts';

async function fixture(t: Parameters<typeof checkFixture>[0]) {
  const f = await checkFixture(t);
  const source = await f.attempt('source', ['First', 'Second']);
  using sql = new DatabaseSync(f.path);
  sql.prepare("UPDATE requests SET state = 'succeeded', result = '{}' WHERE attempt_id = ? AND operation = 'worker.activate'").run(source.id);
  const candidate = f.db.attempt(source.id).candidate!;
  const target: JsonObject = { sourceAttemptId: source.id, candidateId: candidate.id!, commit: candidate.commit!,
    outputRef: candidate.outputRef!, repository: f.db.attempt(source.id).specification.repository!, criteria: ['First', 'Second'],
    checkResults: [{ state: 'succeeded', result: { status: 'passed' } }] };
  const command = (key: string) => ({ requestKey: key, operation: 'attempt.review', caller: person,
    input: { attemptId: source.id, dryRun: false }, fingerprint: canonicalJson({ attemptId: source.id, dryRun: false }) });
  const review = await f.db.createReview(source.id, target, person, command('review'));
  async function worker(taskId = review.id) {
    const reservation = await f.db.reserveAttempt({ requestKey: `dispatch:${taskId}`, taskId, caller: person, startingCommit: start,
      checks: parseCheckPolicy(start, null, contextChecks), delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
    assert.equal(reservation.attempt.specification.startingCommit, head);
    assert.equal((reservation.attempt.specification.delivery as JsonObject).kind, 'review');
    const id = reservation.attempt.id;
    const [claim] = await f.db.registerClaims([{ resourceKey: `review-dispatch:${id}`, role: 'maintenance', generation: 'test', ownerRef: person,
      schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
    const executor = { claimId: claim!.id, generation: claim!.generation };
    const acquisition = await f.db.beginWorkspaceAcquisition(id, reservation.requestId, executor, person);
    const workspace = acquisition.effect.input.workspace as JsonObject;
    const allocation: Allocation = { ...source.allocation, leaseId: `lease:${id}`, path: join(source.allocation.pool, id),
      holder: workspace.holder as JsonObject, startingCommit: head, outputRef: String(reservation.attempt.specification.outputRef) };
    await f.db.recordAllocation(id, acquisition.effect.id, executor, allocation);
    await f.db.startAttempt(id, person);
    const launcher = new FakeLauncher();
    const preparation = await prepareWorker(f.db, id, host, launcher);
    await f.db.decideWorkerLaunch(id, preparation.claimId!, 'permit', host);
    const binding = f.db.workerResultBinding(id);
    const content = { version: 1, identity: binding.identity, startingCommit: head, outputRef: binding.outputRef,
      outcome: 'completed', summary: 'Reviewed', reason: null,
      criteriaReport: ['First', 'Second'].map((criterion, index) => ({ position: index + 1, criterion, status: 'met', evidence: 'Focused test and inspection' })),
      evidence: [], workReferences: [{ kind: 'reviewed-output', name: 'review', target }] };
    async function save() { await mkdir(dirname(binding.resultPath), { recursive: true }); await writeFile(binding.resultPath, JSON.stringify(content)); }
    async function terminal() { await f.db.recordWorkerObservation({ sourceId: id, sourceSequence: 1, attemptId: id,
      workerRef: preparation.result!.reference as WorkerReference, observedAt: new Date().toISOString(), kind: 'terminal', payloadVersion: 1,
      payload: { terminal: true, laterTurnsRefused: true } }, host); }
    return { id, binding, content, save, terminal, allocation, launcher };
  }
  return { ...f, source, target, review, command, worker };
}

test('R17/R18/A36: supervisor review creation checks current source membership and gives the review that objective', async t => {
  const f = await fixture(t);
  await f.db.addObjective({ id: 'goal', request: 'Review', criteria: ['Works'], scope: '', constraints: '', permissions: null, budget: null, deadline: null }, person);
  const caller = { kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
  const command = { ...f.command('supervisor-review'), caller };
  await assert.rejects(f.db.createReview(f.source.id, f.target, caller, command), { code: 'outside_objective' });
  await f.db.moveTask('source', f.db.task('source').definitionRevision, 'goal', person);
  const review = await f.db.createReview(f.source.id, f.target, caller, command);
  assert.equal(review.objectiveId, 'goal');
  assert.equal(f.db.task(review.id).objectiveId, 'goal');
  assert.deepEqual(review.reviewTarget, f.target);
});

test('R13/A28: only attempt.review creates immutable copied targets; creation replays without reopening source launch', async t => {
  const f = await fixture(t);
  assert.equal(f.review.kind, 'review');
  assert.deepEqual(f.review.reviewTarget, f.target);
  await assert.rejects(f.db.addTask({ title: 'Forged', kind: 'review' }, person));
  await assert.rejects(f.db.updateTaskDefinition(f.review.id, { criteria: ['Changed'] }, person));
  await assert.rejects(f.db.updateTaskDefinition(f.review.id, { instructions: 'Changed' }, person));
  await assert.rejects(f.db.updateTaskDefinition('source', { kind: 'review' }, person));
  await f.db.updateTaskDefinition('source', { criteria: ['Changed'] }, person);
  assert.deepEqual(f.db.task(f.review.id).criteria, ['First', 'Second']);
  assert.deepEqual(await f.db.createReview(f.source.id, {}, person, f.command('review')), f.review);
  const owner = f.db.claims().find(c => c.attemptId === f.source.id && c.role === 'worker_owner')!;
  await assert.rejects(f.db.decideWorkerLaunch(f.source.id, owner.id, 'permit', host));
});

for (const status of ['met', 'not_met']) test(`R13/A28: retained ${status} review records verdict and outcome atomically, with replay deduplicated`, async t => {
  const f = await fixture(t), worker = await f.worker();
  worker.content.criteriaReport[1]!.status = status;
  const prompt = piWorkerPrompt({ ...worker.launcher.workers.values().next().value!.binding });
  assert.match(prompt, /focused tests rather than the full suite again/u);
  assert.match(prompt, /Do not commit changes/u);
  assert.match(prompt, /checkResults/u);
  assert.deepEqual(worker.binding.reviewTarget, f.target);
  await worker.save();
  assert.equal((await f.db.completeWorker(worker.id, host, retention)).outcome, null, 'No terminal observation means no verdict');
  assert.equal(f.db.reviewEvidence(f.source.id).current, null);
  await worker.terminal();
  // A failing verdict insert must roll back both the outcome and task transition.
  using sql = new DatabaseSync(f.path);
  sql.exec("CREATE TRIGGER fail_review BEFORE INSERT ON events WHEN NEW.kind = 'review.recorded' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
  await assert.rejects(f.db.completeWorker(worker.id, host, retention));
  assert.equal(f.db.attempt(worker.id).outcome, null);
  assert.equal(f.db.task(f.review.id).state, 'in_flight');
  sql.exec('DROP TRIGGER fail_review');
  await f.db.completeWorker(worker.id, host, retention);
  assert.equal(f.db.task(f.review.id).state, 'done');
  assert.equal(f.db.reviewEvidence(f.source.id).current!.payload.verdict, status === 'met' ? 'passed' : 'failed');
  const caller = { kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'goal', sessionId: 'session' };
  if (status === 'met') f.db.requireSupervisorReview(caller, f.source.id, head);
  else assert.throws(() => f.db.requireSupervisorReview(caller, f.source.id, head), { code: 'review_failed' });
  assert.throws(() => f.db.requireSupervisorReview(caller, f.source.id, start), { code: 'review_missing' });
  assert.equal(f.db.acceptance(f.source.id, String(f.target.candidateId)), null);
  await f.db.completeWorker(worker.id, host, retention);
  assert.equal(f.db.reviewEvidence(f.source.id).findings.length, 1);
});

for (const invalid of ['wrong-target', 'missing-target', 'duplicate-target', 'missing-criterion', 'interrupted'] as const) {
  test(`R13/A19/A29: ${invalid} produces no verdict`, async t => {
    const f = await fixture(t), worker = await f.worker();
    if (invalid === 'wrong-target') worker.content.workReferences[0]!.target = { ...f.target, commit: start };
    if (invalid === 'missing-target') worker.content.workReferences = [];
    if (invalid === 'duplicate-target') worker.content.workReferences.push({ ...worker.content.workReferences[0]!, name: 'duplicate' });
    if (invalid === 'missing-criterion') worker.content.criteriaReport.pop();
    if (invalid === 'interrupted') Object.assign(worker.content, { outcome: 'held', reason: 'Interrupted' });
    await worker.save(); await worker.terminal();
    if (invalid === 'interrupted') await f.db.completeWorker(worker.id, host, retention);
    else await assert.rejects(f.db.completeWorker(worker.id, host, retention));
    assert.equal(f.db.reviewEvidence(f.source.id).current, null);
    assert.equal(f.db.reviewEvidence(f.source.id).findings.length, 0);
  });
}

test('R13/A29: latest matching verdict replaces earlier findings; a replaced candidate gets none', async t => {
  const f = await fixture(t), first = await f.worker();
  await first.save(); await first.terminal(); await f.db.completeWorker(first.id, host, retention);
  const secondTask = await f.db.createReview(f.source.id, f.target, person, f.command('second'));
  const second = await f.worker(secondTask.id);
  second.content.criteriaReport[0]!.status = 'not_met';
  await second.save(); await second.terminal(); await f.db.completeWorker(second.id, host, retention);
  assert.equal(f.db.reviewEvidence(f.source.id).current!.payload.verdict, 'failed');
  await f.db.updateTaskDefinition('source', { criteria: ['New criteria'] }, person);
  assert.equal(f.db.reviewEvidence(f.source.id).current, null);
  assert.equal(f.db.reviewEvidence(f.source.id).findings.length, 2);
  await f.db.updateTaskDefinition('source', { criteria: ['First', 'Second'] }, person);
  assert.equal(f.db.reviewEvidence(f.source.id).current!.payload.verdict, 'failed');
  const thirdTask = await f.db.createReview(f.source.id, f.target, person, f.command('third'));
  const third = await f.worker(thirdTask.id);
  using sql = new DatabaseSync(f.path);
  sql.prepare('UPDATE attempts SET candidate = ? WHERE id = ?').run(JSON.stringify({ id: 'replacement', commit: 'c'.repeat(40), outputRef: f.target.outputRef }), f.source.id);
  await third.save(); await third.terminal(); await f.db.completeWorker(third.id, host, retention);
  const evidence = f.db.reviewEvidence(f.source.id);
  assert.equal(evidence.current, null);
  assert.equal(evidence.findings.length, 2);
  assert.equal(f.db.task(thirdTask.id).state, 'done');
});

test('R13/A27: missing candidate, running source and unresolved source effect refuse creation', async t => {
  const f = await fixture(t);
  using sql = new DatabaseSync(f.path);
  sql.prepare('UPDATE attempts SET execution_open = 1 WHERE id = ?').run(f.source.id);
  assert.throws(() => f.db.reviewSource(f.source.id));
  sql.prepare('UPDATE attempts SET execution_open = 0, candidate = NULL WHERE id = ?').run(f.source.id);
  assert.throws(() => f.db.reviewSource(f.source.id));
  assert.throws(() => f.db.reviewSource('unknown'));
  sql.prepare('UPDATE attempts SET candidate = ? WHERE id = ?').run(JSON.stringify({ id: f.target.candidateId, commit: head, outputRef: f.target.outputRef }), f.source.id);
  sql.prepare("UPDATE requests SET state = 'uncertain' WHERE attempt_id = ? AND operation = 'worker.activate'").run(f.source.id);
  assert.throws(() => f.db.reviewSource(f.source.id));
});

test('R13/A28: copied criteria survive source edits; unretained review cannot record a verdict', async t => {
  const f = await fixture(t), worker = await f.worker();
  await f.db.updateTaskDefinition('source', { criteria: ['Replacement'] }, person);
  await worker.save(); await worker.terminal();
  await readWorkerResult(worker.binding);
  await assert.rejects(f.db.completeWorker(worker.id, host, { ...retention, verifyRetention: async () => rejected('Not retained') }));
  assert.equal(f.db.reviewEvidence(f.source.id).findings.length, 0);
  await f.db.completeWorker(worker.id, host, retention);
  assert.deepEqual(f.db.reviewEvidence(f.source.id).findings[0]!.payload.criteria, ['First', 'Second']);
  assert.equal(f.db.reviewEvidence(f.source.id).current, null);
});
