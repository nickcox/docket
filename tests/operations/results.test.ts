import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { applicationId, Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, JsonObject } from '../../src/storage/database.ts';
import type { WorkerHost, WorkerReference } from '../../src/storage/launch.ts';
import type { WorkerObservation } from '../../src/storage/results.ts';
import { maximumResultBytes } from '../../src/storage/results.ts';
import type { Allocation } from '../../src/storage/reservations.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { observeWorker, prepareWorker } from '../../src/workers.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';

const person = { kind: 'person' as const, id: 'operator' };
const host: WorkerHost = { kind: 'host', id: 'backend', generation: 'generation-1' };
const start = 'a'.repeat(40), head = 'b'.repeat(40);
const repository = { compare: async () => confirmed(true), verifyRetention: async () => confirmed({ retained: true as const }) };
const refuses = (code: string, reason?: RegExp) => (error: unknown) => error instanceof StorageError
  && error.code === code && (reason === undefined || reason.test(error.message));

type TestContext = { after: (fn: () => Promise<void> | void) => void };
async function fixture(t: TestContext, kind: 'code' | 'report' = 'code', deliverables: string[] = []) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [join(root, 'pool')] }, readOnly: false, retryMs: 1000 };
  const profile = { launcher: 'bb', provider: 'example', model: 'model', reasoning: null,
    runMs: 1000, maxCost: 0, maxTokens: null, executionProfile: 'test' };
  const db = await Database.initialise(path, { contextId: 'results', repository: { identity: 'example' },
    stateDirectory: root, createdBy: person, configuration: { revision: 1, digest: 'test', provenance: {}, resolved: {
      version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
      limits: { maxAttempts: 10, maxAttemptsPerTask: 3, maxConcurrentFullChecks: 1 }, profiles: { worker: profile },
      defaultProfile: 'worker', profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
      finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] },
    } } }, options);
  t.after(() => db.close());
  const [claim] = await db.registerClaims([{ resourceKey: 'dispatch', role: 'maintenance', generation: 'dispatch-1', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const executor = { claimId: claim!.id, generation: claim!.generation };
  await db.addTask({ id: 'task', title: 'Task', kind, criteria: ['First criterion', 'Second criterion'] }, person);
  const reservation = await db.reserveAttempt({ requestKey: 'dispatch', taskId: 'task', caller: person, startingCommit: start,
    checks: { sourceCommit: start, digest: 'checks', fast: [], full: [] },
    delivery: { kind, acceptance: 'review_or_integration', requiredEvidence: ['tests'], requiredDeliverables: deliverables } });
  const attemptId = reservation.attempt.id;
  const acquisition = await db.beginWorkspaceAcquisition(attemptId, reservation.requestId, executor, person);
  const input = acquisition.effect.input, workspace = input.workspace as JsonObject;
  const allocation: Allocation = { leaseId: 'lease', holder: workspace.holder as JsonObject,
    path: join(String(workspace.pool), 'task'), pool: String(workspace.pool), repository: input.repository as JsonObject,
    outputRef: String(input.outputRef), startingCommit: String(input.startingCommit) };
  await db.recordAllocation(attemptId, acquisition.effect.id, executor, allocation);
  await db.startAttempt(attemptId, person);
  const launcher = new FakeLauncher();
  const preparation = await prepareWorker(db, attemptId, host, launcher);
  const reference = preparation.result!.reference as WorkerReference;
  const claimId = preparation.claimId!;
  await db.decideWorkerLaunch(attemptId, claimId, 'permit', host);
  const binding = db.workerResultBinding(attemptId);
  const result: JsonObject = { version: 1, identity: binding.identity, startingCommit: start, outputRef: binding.outputRef,
    outcome: 'completed', summary: 'Implemented the work', reason: null,
    criteriaReport: binding.criteria.map((criterion, index) => ({ position: index + 1, criterion, status: 'met', evidence: 'Tested' })),
    evidence: [{ name: 'tests', summary: 'Tests pass' }],
    workReferences: kind === 'code' ? [{ kind: 'git', name: 'code', branch: binding.outputRef, commit: head }] : [] };
  await mkdir(dirname(binding.resultPath), { recursive: true });
  async function save(value: JsonObject = result) { await writeFile(binding.resultPath, JSON.stringify(value)); }
  let sequence = 100;
  function observation(kind: WorkerObservation['kind'], sourceSequence = sequence++): WorkerObservation {
    return { sourceId: 'worker-events', sourceSequence, attemptId, workerRef: reference,
      observedAt: '2026-11-08T09:00:00.000Z', kind, payloadVersion: 1,
      payload: kind === 'terminal' ? { terminal: true, laterTurnsRefused: true } : {} };
  }
  async function observe(kind: WorkerObservation['kind'], sourceSequence?: number) {
    return observeWorker(db, observation(kind, sourceSequence), host, repository);
  }
  return { db, root, path, options, attemptId, binding, result, save, observation, observe, reference, claimId };
}

function clone(value: JsonObject): JsonObject { return structuredClone(value); }
function permutations<T>(values: T[]): T[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
}

test('R07/A17: every ordering, duplicate and old source sequence completes once, only with terminal plus validated result', async t => {
  for (const order of permutations<WorkerObservation['kind']>(['terminal', 'turn_ended', 'idle', 'result_available'])) {
    const f = await fixture(t);
    await f.save();
    const seen = new Set<string>();
    for (const kind of order) {
      const observation = f.observation(kind, kind === 'terminal' ? 1 : kind === 'result_available' ? 2 : kind === 'idle' ? 99 : 100);
      seen.add(kind);
      for (let duplicate = 0; duplicate < 2; duplicate++) {
        const attempt = await observeWorker(f.db, observation, host, repository);
        assert.equal(attempt.outcome, seen.has('terminal') && seen.has('result_available') ? 'completed' : null, order.join(','));
      }
    }
    assert.equal(f.db.events().filter(event => event.kind === 'attempt.completed').length, 1);
    assert.equal(f.db.events().filter(event => event.kind === 'attempt.result_validated').length, 1);
    assert.equal(f.db.events().filter(event => event.kind === 'worker.observed').length, 4);
    assert.equal(f.db.attempt(f.attemptId).candidate!.commit, head);
    assert.equal(f.db.attempt(f.attemptId).executionOpen, false);
    assert.equal(f.db.attempt(f.attemptId).leaseState, 'held');
    assert.equal(f.db.task('task').holdReason, 'awaiting_acceptance');
    assert.equal(f.db.task('task').state, 'queued');
  }
});

test('R07/A17: file existence, idle and turn-end alone do not validate or complete; terminal without a result stays open', async t => {
  const f = await fixture(t);
  await f.save();
  await f.observe('idle'); await f.observe('turn_ended');
  assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
  await unlink(f.binding.resultPath);
  await f.observe('terminal');
  assert.equal(f.db.attempt(f.attemptId).outcome, null);
  assert.equal(f.db.attempt(f.attemptId).executionOpen, true);
  await assert.rejects(f.observe('result_available'), refuses('result_invalid', /Cannot read/));
  await f.save();
  assert.equal((await f.observe('result_available')).outcome, 'completed');
});

test('R11/A17: oversized, linked, non-regular and malformed result files are refused without validation evidence', async t => {
  for (const scenario of ['oversized', 'symlink', 'hardlink', 'directory', 'parent-link', 'malformed', 'invalid-utf8'] as const) {
    const f = await fixture(t);
    await f.save();
    if (scenario === 'oversized') await writeFile(f.binding.resultPath, ' '.repeat(maximumResultBytes + 1));
    if (scenario === 'symlink' || scenario === 'hardlink') {
      const other = join(f.root, 'other.json'); await writeFile(other, JSON.stringify(f.result)); await unlink(f.binding.resultPath);
      if (scenario === 'symlink') await symlink(other, f.binding.resultPath); else await link(other, f.binding.resultPath);
    }
    if (scenario === 'parent-link') {
      const directory = dirname(f.binding.resultPath), other = join(f.root, 'other');
      await mkdir(other); await writeFile(join(other, 'result.json'), JSON.stringify(f.result));
      await rm(directory, { recursive: true }); await symlink(other, directory);
    }
    if (scenario === 'directory') { await unlink(f.binding.resultPath); await mkdir(f.binding.resultPath); }
    if (scenario === 'malformed') await writeFile(f.binding.resultPath, '{');
    if (scenario === 'invalid-utf8') await writeFile(f.binding.resultPath, Buffer.from([0xff]));
    await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_invalid'));
    assert.equal(f.db.validatedWorkerResult(f.attemptId), null, scenario);
  }
});

test('R11/A17: every identity field and exact starting/output refs are bound to the stored attempt', async t => {
  const f = await fixture(t);
  for (const name of ['databaseId', 'contextId', 'taskId', 'attemptId', 'leaseId', 'sessionId', 'startingCommit', 'outputRef']) {
    const value = clone(f.result);
    if (name === 'startingCommit' || name === 'outputRef') value[name] = 'wrong';
    else (value.identity as JsonObject)[name] = 'wrong';
    await f.save(value);
    await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_identity_mismatch'));
    assert.equal(f.db.validatedWorkerResult(f.attemptId), null, name);
  }
});

test('R11: every criterion exactly once by position and exact text, also for held and failed results', async t => {
  const f = await fixture(t);
  for (const outcome of ['completed', 'held', 'failed']) {
    for (const scenario of ['missing', 'duplicate', 'text', 'position', 'status', 'evidence']) {
      const value = clone(f.result); value.outcome = outcome; value.reason = outcome === 'completed' ? null : 'Cannot finish';
      const criteria = value.criteriaReport as JsonObject[];
      if (scenario === 'missing') criteria.pop();
      if (scenario === 'duplicate') criteria[1] = criteria[0]!;
      if (scenario === 'text') criteria[0]!.criterion = 'First criterion ';
      if (scenario === 'position') criteria[0]!.position = 0;
      if (scenario === 'status') criteria[0]!.status = 'unknown';
      if (scenario === 'evidence') criteria[0]!.evidence = '';
      await f.save(value);
      await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_invalid'));
      assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
    }
  }
  // Ordering is not identity: the positions, not array order, determine matching.
  (f.result.criteriaReport as JsonObject[]).reverse(); await f.save();
  await f.db.validateWorkerResult(f.attemptId, host, repository);
});

test('R11: required evidence and deliverables are checked, artefacts are retained regular files with digests', async t => {
  const f = await fixture(t, 'report', ['report']);
  await f.save();
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host), refuses('result_invalid', /deliverable/));
  f.result.workReferences = [{ kind: 'artefact', name: 'report', path: 'report.txt', description: 'Report' }];
  f.result.evidence = []; await f.save();
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host), refuses('result_invalid', /evidence/));
  f.result.evidence = [{ name: 'tests', summary: 'Tested' }]; await f.save();
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host), refuses('result_invalid', /Cannot read/));
  await writeFile(join(dirname(f.binding.resultPath), 'report.txt'), 'Retained report');
  const result = await (f.save().then(() => f.db.validateWorkerResult(f.attemptId, host)));
  assert.deepEqual(result.artefacts, [{ name: 'report', relativePath: 'report.txt', digest: createHash('sha256').update('Retained report').digest('hex') }]);
  assert.equal((await f.observe('terminal')).outcome, 'completed');
  assert.equal(f.db.task('task').state, 'done');
});

test('R11: artefact traversal, absolute paths, links and recyclable storage are refused', async t => {
  for (const name of ['../escape.txt', '/tmp/escape.txt', 'folder/../escape.txt', 'linked.txt', 'folder/linked.txt']) {
    const f = await fixture(t, 'report', ['report']);
    const root = dirname(f.binding.resultPath);
    await writeFile(join(f.root, 'escape.txt'), 'Outside');
    if (name === 'linked.txt') await symlink(join(f.root, 'escape.txt'), join(root, name));
    if (name === 'folder/linked.txt') { await mkdir(join(root, 'folder')); await symlink(join(f.root, 'escape.txt'), join(root, name)); }
    f.result.workReferences = [{ kind: 'artefact', name: 'report', path: name, description: 'Report' }];
    await f.save();
    await assert.rejects(f.db.validateWorkerResult(f.attemptId, host), refuses('result_invalid'));
    assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
  }
});

test('R11: validation is write-once, persists across reopening, and changed or missing files are discrepancies', async t => {
  const f = await fixture(t); await f.save();
  const source = JSON.stringify(f.result);
  const original = await f.db.validateWorkerResult(f.attemptId, host, repository);
  assert.equal(original.digest, createHash('sha256').update(source).digest('hex'));
  assert.equal(original.relativePath, 'result.json'); assert.equal(original.validationVersion, 1);
  assert.ok(Number.isFinite(Date.parse(original.validatedAt))); assert.deepEqual(original.content, f.result);
  assert.deepEqual(await f.db.validateWorkerResult(f.attemptId, host, repository), original);
  const reopened = await Database.open(f.path, f.options); t.after(() => reopened.close());
  assert.deepEqual(reopened.validatedWorkerResult(f.attemptId), original);
  await writeFile(f.binding.resultPath, source + '\n');
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_discrepancy'));
  await writeFile(f.binding.resultPath, '{');
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_discrepancy'));
  await unlink(f.binding.resultPath);
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_discrepancy'));
  assert.deepEqual(f.db.validatedWorkerResult(f.attemptId), original);
  assert.equal(f.db.events().filter(event => event.kind === 'attempt.result_validated').length, 1);
});

test('R11: changed or missing retained artefacts are discrepancies and block completion', async t => {
  const f = await fixture(t, 'report', ['report']);
  const path = join(dirname(f.binding.resultPath), 'report.txt');
  f.result.workReferences = [{ kind: 'artefact', name: 'report', path: 'report.txt', description: 'Report' }];
  await writeFile(path, 'Original'); await f.save(); await f.observe('result_available');
  const original = f.db.validatedWorkerResult(f.attemptId);
  await writeFile(path, 'Changed');
  await assert.rejects(f.observe('terminal'), refuses('result_discrepancy'));
  await unlink(path);
  await assert.rejects(f.db.completeWorker(f.attemptId, host), refuses('result_discrepancy'));
  assert.equal(f.db.attempt(f.attemptId).outcome, null);
  assert.deepEqual(f.db.validatedWorkerResult(f.attemptId), original);
});

test('R11: starting commit, unrelated commit, unretained candidate and unknown repository evidence cannot become candidates', async t => {
  const f = await fixture(t);
  (f.result.workReferences as JsonObject[])[0]!.commit = start; await f.save();
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_invalid', /starting commit/));
  (f.result.workReferences as JsonObject[])[0]!.commit = head; await f.save();
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host), refuses('result_invalid', /repository/));
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, { ...repository, compare: async () => confirmed(false) }), refuses('result_invalid', /descend/));
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, { ...repository, compare: async () => uncertain('Unknown ancestry') }), refuses('result_invalid', /descend/));
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, { ...repository, verifyRetention: async () => rejected('Absent ref') }), refuses('result_invalid', /retained/));
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, { ...repository, verifyRetention: async () => uncertain('Unknown ref') }), refuses('result_invalid', /retained/));
  assert.equal(f.db.attempt(f.attemptId).candidate, null);
  assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
});

test('R10/A05: automated completed, held and failed outcomes preserve every newer person hold, done and reopen', async t => {
  for (const outcome of ['completed', 'held', 'failed']) {
    for (const decision of ['hold', 'done', 'reopen']) {
      const f = await fixture(t);
      f.result.outcome = outcome; f.result.reason = outcome === 'completed' ? null : 'Cannot finish';
      await f.save(); await f.observe('result_available');
      if (decision === 'hold') await f.db.holdTask('task', 'Person decision', person);
      if (decision === 'done') await f.db.markTaskDone('task', person);
      if (decision === 'reopen') await f.db.reopenTask('task', person);
      const before = f.db.task('task');
      assert.equal((await f.observe('terminal')).outcome, outcome);
      assert.deepEqual(f.db.task('task'), before, `${outcome}/${decision}`);
      assert.equal(f.db.events().filter(event => event.kind === 'attempt.completed').length, 1);
    }
  }
});

test('R10: held and failed results record their outcome, hold the task and never invent a candidate', async t => {
  for (const outcome of ['held', 'failed']) {
    const f = await fixture(t);
    f.result.outcome = outcome; f.result.reason = 'Cannot finish'; f.result.workReferences = [];
    await f.save(); await f.observe('terminal');
    const attempt = await f.observe('result_available');
    assert.equal(attempt.outcome, outcome); assert.equal(attempt.candidate, null); assert.equal(attempt.executionOpen, false);
    assert.equal(f.db.task('task').holdReason, `worker_${outcome}`);
    assert.equal(attempt.leaseState, 'held');
  }
});

test('R07: wrong worker, host, duplicate source content and inadequate terminal proof cannot supply terminal evidence', async t => {
  const f = await fixture(t); await f.save();
  const observation = f.observation('terminal');
  await assert.rejects(f.db.recordWorkerObservation({ ...observation, workerRef: { launcher: 'bb', threadId: 'other' } }, host), refuses('result_identity_mismatch'));
  await assert.rejects(f.db.recordWorkerObservation(observation, { ...host, generation: 'other' }), refuses('conflict'));
  await assert.rejects(f.db.recordWorkerObservation({ ...observation, payload: { terminal: true, laterTurnsRefused: false } }, host), refuses('result_invalid'));
  await assert.rejects(f.db.recordWorkerObservation({ ...observation, payload: { noProcesses: true } }, host), refuses('result_invalid'));
  assert.equal(f.db.events().filter(event => event.kind === 'worker.observed').length, 0);
  await f.db.recordWorkerObservation(observation, host);
  await assert.rejects(f.db.recordWorkerObservation({ ...observation, kind: 'idle', payload: {} }, host), refuses('conflict'));
});

test('R10/R25: an interrupted completion rolls back outcome, candidate, task change and event together', async t => {
  const f = await fixture(t); await f.save(); await f.observe('result_available');
  await f.db.recordWorkerObservation(f.observation('terminal'), host);
  const before = f.db.attempt(f.attemptId), task = f.db.task('task');
  const target = f.db as unknown as { insertEvent: (event: EventInput) => unknown };
  const original = target.insertEvent;
  target.insertEvent = function (event) {
    const value = original.call(this, event);
    if (event.kind === 'attempt.completed') throw new Error('injected failure');
    return value;
  };
  await assert.rejects(f.db.completeWorker(f.attemptId, host), /injected failure/);
  target.insertEvent = original;
  assert.deepEqual(f.db.attempt(f.attemptId), before); assert.deepEqual(f.db.task('task'), task);
  assert.equal(f.db.events().filter(event => event.kind === 'attempt.completed').length, 0);
  assert.equal((await f.db.completeWorker(f.attemptId, host)).outcome, 'completed');
});

test('R11/A17: exactly 1 MiB is allowed; the limit counts UTF-8 bytes, not characters', async t => {
  const f = await fixture(t);
  const source = JSON.stringify(f.result);
  await writeFile(f.binding.resultPath, source + ' '.repeat(maximumResultBytes - Buffer.byteLength(source)));
  assert.ok(await f.db.validateWorkerResult(f.attemptId, host, repository));
  const other = await fixture(t);
  other.result.summary = '🙂'.repeat(maximumResultBytes / 4);
  await other.save();
  await assert.rejects(other.db.validateWorkerResult(other.attemptId, host, repository), refuses('result_invalid', /1 MiB/));
  assert.equal(other.db.validatedWorkerResult(other.attemptId), null);
});

test('R11: malformed result fields and incomplete work references refuse with no validated record', async t => {
  const f = await fixture(t);
  const changes: ((value: JsonObject) => void)[] = [
    value => { value.version = 2; },
    value => { value.extra = true; },
    value => { delete value.reason; },
    value => { value.reason = 'Unexpected completed reason'; },
    value => { value.outcome = 'idle'; },
    value => { value.summary = ''; },
    value => { value.workReferences = []; },
    value => { (value.workReferences as JsonObject[])[0]!.commit = 'HEAD'; },
    value => { (value.workReferences as JsonObject[])[0]!.branch = 'main'; },
    value => { (value.workReferences as JsonObject[]).push((value.workReferences as JsonObject[])[0]!); },
    value => { (value.evidence as JsonObject[]).push((value.evidence as JsonObject[])[0]!); },
    value => { value.outcome = 'held'; value.reason = ''; },
    value => { value.outcome = 'failed'; value.reason = null; },
  ];
  for (const change of changes) {
    const value = clone(f.result); change(value); await f.save(value);
    await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), refuses('result_invalid'));
    assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
  }
});

test('R11: the host inventory also excludes recyclable roots other than this attempt pool', async t => {
  const f = await fixture(t); await f.save();
  const other = await Database.open(f.path, { ...f.options,
    location: { retainedRoot: f.root, recyclableRoots: [dirname(f.binding.resultPath)] } });
  t.after(() => other.close());
  await assert.rejects(other.validateWorkerResult(f.attemptId, host, repository), refuses('result_invalid', /recyclable/));
  assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
});

test('R07: Pi terminal proof requires direct child exit and rejects process-stop claims', async () => {
  const { workerObservation } = await import('../../src/storage/results.ts');
  const observation: WorkerObservation = { sourceId: 'pi', sourceSequence: 1, attemptId: 'attempt',
    workerRef: { launcher: 'pi', sessionId: 'session', processId: '123' }, observedAt: new Date().toISOString(),
    kind: 'terminal', payloadVersion: 1, payload: { directChildExited: true } };
  workerObservation(observation);
  assert.throws(() => workerObservation({ ...observation, payload: { directChildExited: false } }), refuses('result_invalid'));
  assert.throws(() => workerObservation({ ...observation, payload: { directChildExited: true, noProcesses: true } }), refuses('result_invalid'));
});

test('R10/R25: simultaneous validation and completion through independent stores retain one result and outcome', async t => {
  const f = await fixture(t); await f.save();
  const other = await Database.open(f.path, f.options); t.after(() => other.close());
  await f.db.recordWorkerObservation(f.observation('terminal'), host);
  const results = await Promise.all([f.db.validateWorkerResult(f.attemptId, host, repository), other.validateWorkerResult(f.attemptId, host, repository)]);
  assert.deepEqual(results[0], results[1]);
  const attempts = await Promise.all([f.db.completeWorker(f.attemptId, host), other.completeWorker(f.attemptId, host)]);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(f.db.events().filter(event => event.kind === 'attempt.result_validated').length, 1);
  assert.equal(f.db.events().filter(event => event.kind === 'attempt.completed').length, 1);
});

test('R11/R25: result validation rolls back completely if its evidence insertion fails', async t => {
  const f = await fixture(t); await f.save();
  const target = f.db as unknown as { insertEvent: (event: EventInput) => unknown };
  const original = target.insertEvent;
  target.insertEvent = function (event) {
    const value = original.call(this, event);
    if (event.kind === 'attempt.result_validated') throw new Error('injected validation failure');
    return value;
  };
  await assert.rejects(f.db.validateWorkerResult(f.attemptId, host, repository), /injected validation failure/);
  target.insertEvent = original;
  assert.equal(f.db.validatedWorkerResult(f.attemptId), null);
  assert.ok(await f.db.validateWorkerResult(f.attemptId, host, repository));
});
