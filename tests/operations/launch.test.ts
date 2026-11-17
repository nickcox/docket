import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applicationId, Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, JsonObject } from '../../src/storage/database.ts';
import type { WorkerHost, WorkerReference } from '../../src/storage/launch.ts';
import type { Allocation } from '../../src/storage/reservations.ts';
import { activateWorker, prepareWorker, controlWorker } from '../../src/workers.ts';
import { confirmed, rejected, uncertain } from '../../src/adapters/command.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';
import { PiLauncher } from '../../src/adapters/pi.ts';
import { canonicalJson } from '../../src/configuration.ts';
import { returnAttempt } from '../../src/completion.ts';
import type { CompletionServices } from '../../src/completion.ts';

const person = { kind: 'person' as const, id: 'operator' };
const host: WorkerHost = { kind: 'host', id: 'backend', generation: 'generation-1' };
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';
const hash = 'a'.repeat(40);

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-launch-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, readOnly: false, retryMs: 1000 };
  const profile = { launcher: 'bb', provider: 'example', model: 'model', reasoning: null,
    runMs: 1000, maxCost: 0, maxTokens: null, executionProfile: 'test' };
  const db = await Database.initialise(path, { contextId: 'launch', repository: { identity: 'example' },
    stateDirectory: root, createdBy: person, configuration: { revision: 1, digest: 'test', provenance: {}, resolved: {
      version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
      limits: { maxAttempts: 10, maxAttemptsPerTask: 3, maxConcurrentFullChecks: 1 }, profiles: { worker: profile, other: { ...profile, launcher: 'pi' } },
      defaultProfile: 'worker', profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
      finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] },
    } } }, options);
  defer(t, () => db.close());
  const [claim] = await db.registerClaims([{ resourceKey: 'dispatch', role: 'maintenance', generation: 'dispatch-1', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const executor = { claimId: claim!.id, generation: claim!.generation };
  async function allocated(taskId = 'task', profile?: string) {
    await db.addTask({ id: taskId, title: taskId }, person);
    const reservation = await db.reserveAttempt({ requestKey: `dispatch:${taskId}`, taskId, caller: person, ...(profile ? { profile } : {}), startingCommit: hash,
      checks: { sourceCommit: hash, digest: 'checks', fast: [], full: [] },
      delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: ['tests'], requiredDeliverables: [] } });
    const acquisition = await db.beginWorkspaceAcquisition(reservation.attempt.id, reservation.requestId, executor, person);
    const input = acquisition.effect.input, workspace = input.workspace as JsonObject;
    const allocation: Allocation = { leaseId: `lease-${taskId}`, holder: workspace.holder as JsonObject,
      path: join(String(workspace.pool), taskId), pool: String(workspace.pool), repository: input.repository as JsonObject,
      outputRef: String(input.outputRef), startingCommit: String(input.startingCommit) };
    await db.recordAllocation(reservation.attempt.id, acquisition.effect.id, executor, allocation);
    return { attemptId: reservation.attempt.id, requestId: reservation.requestId, allocation };
  }
  async function started(taskId = 'task', profile?: string) {
    const value = await allocated(taskId, profile);
    assert.equal((await db.startAttempt(value.attemptId, person)).phase, 'running');
    const claimId = await db.registerWorkerOwner(value.attemptId, host);
    return { ...value, claimId };
  }
  async function prepared(taskId = 'task', profile?: string) {
    const value = await started(taskId, profile), launcher = new FakeLauncher();
    const effect = await prepareWorker(db, value.attemptId, host, launcher);
    launcher.admit = async reference => reference.launcher !== 'bb'
      || (await db.admitInitialBbPrompt(value.attemptId, String(reference.threadId), host)).kind === 'admitted';
    return { ...value, launcher, prepare: effect, reference: effect.result!.reference as WorkerReference };
  }
  return { db, root, path, options, allocated, started, prepared };
}

test('R07/R08/A14/A16/A17: unbound uncertain preparation needs scoped stop confirmation and resolved ownership before discard', async t => {
  for (const released of [false, true]) {
    const { db, started } = await fixture(t), a = await started('task', 'other');
    const launcher = new FakeLauncher();
    launcher.beforePrepare = async () => uncertain('Preparation timed out after starting the process');
    const prepare = await prepareWorker(db, a.attemptId, host, launcher);
    assert.equal(prepare.state, 'uncertain');
    const executor = { claimId: a.claimId, generation: host.generation };
    const parent = await db.recordCommand({ requestKey: 'emergency', operation: 'attempt.stop', caller: host, input: {}, fingerprint: 'emergency' });
    const stop = await db.recordEffect({ requestKey: 'emergency-effect', operation: 'worker.emergency-stop', caller: host,
      input: {}, fingerprint: 'emergency', parentId: parent.id, executor, attemptId: a.attemptId,
      target: { kind: 'worker', reference: { launcher: 'pi', sessionId: String(prepare.input.sessionId) } } });
    await db.claimEffect(stop.id, executor);
    await db.recordEffectOutcome(stop.id, executor, 'succeeded', { status: 'confirmed', value: { exit: { code: null, signal: 'SIGTERM' }, terminal: true } });
    let returned = false;
    const unused = async (): Promise<never> => { throw new Error('Unexpected external call'); };
    const services: CompletionServices = {
      profile: { id: 'test', tools: {}, dependencies: {} }, run: unused,
      repository: { identity: unused, readCheckPolicy: unused, inspectRef: async () => confirmed({ state: 'absent' }),
        inspectWorkspace: async () => confirmed({ branch: a.allocation.outputRef, head: hash, clean: true, uncommitted: [], untracked: [] }),
        compare: unused, verifyRetention: unused, conditionalFastForward: unused, conditionalDeleteRef: unused,
        command: unused, createPinnedRef: unused, conditionalMoveRef: unused, prepareRebase: unused },
      workspace: { inspect: async () => confirmed({ state: returned ? 'absent' : 'matching' }),
        returnLease: async () => { returned = true; return confirmed({ returned: true }); } },
    };
    const discard = { requestKey: 'discard-unbound', attemptId: a.attemptId, caller: person,
      discard: { leaseId: a.allocation.leaseId, confirmed: true as const, reason: 'Abandoned preparation' } };
    await assert.rejects(returnAttempt(db, discard, services), /terminal/);
    const effectInput = { effectId: prepare.id, outcome: 'happened', confirmStopped: true, evidence: 'Exact prepare process stopped by emergency stop', dryRun: false };
    const resolveEffect = () => db.resolveEffectByPerson(prepare.id, true, effectInput.evidence, person, { requestKey: 'resolve-prepare',
      operation: 'effect.resolve', caller: person, input: effectInput, fingerprint: canonicalJson(effectInput) });
    if (!released) {
      await resolveEffect();
      await assert.rejects(returnAttempt(db, discard, services), /terminal/, 'Effect resolution does not resolve worker ownership');
    }
    const claim = db.claim(a.claimId);
    if (released) await db.releaseClaim(executor, { evidence: 'Earlier owner release without terminal evidence' }, host);
    const input = { claimId: claim.id, confirmStopped: true, evidence: 'Exact unbound worker and owner inspected and stopped', dryRun: false };
    const resolve = (key: string, confirmStopped = true) => db.resolveClaimByPerson(claim.id, input.evidence, person,
      { requestKey: key, operation: 'claim.resolve', caller: person, input: { ...input, confirmStopped }, fingerprint: canonicalJson({ ...input, confirmStopped }) });
    await assert.rejects(resolve('no-confirmation', false), /process_confirmation_required/);
    await assert.rejects(returnAttempt(db, discard, services), /terminal/);
    await resolve('resolve-owner');
    if (released) {
      await assert.rejects(returnAttempt(db, discard, services), /unresolved effect/);
      assert.equal(returned, false);
      assert.equal(db.attempt(a.attemptId).leaseState, 'held');
      await resolveEffect();
    }
    await resolve('resolve-owner');
    await resolve('recheck-owner');
    const terminal = db.events().filter(e => e.attemptId === a.attemptId && e.kind === 'worker.observed' && e.payload.kind === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.payload.workerRef, null, 'Recovery must not invent a bound reference');
    assert.deepEqual(terminal[0]!.payload.payload, { personConfirmedStopped: true, evidence: input.evidence,
      scope: { claimId: claim.id, generation: claim.generation, ownerRef: claim.ownerRef, commandRequestKey: 'resolve-owner' } });
    const [held] = await db.registerClaims([{ resourceKey: `worker:${a.attemptId}`, role: 'worker_owner', attemptId: a.attemptId,
      generation: host.generation, ownerRef: host, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1,
      heartbeatAt: new Date().toISOString() }], host);
    await assert.rejects(returnAttempt(db, discard, services), /claim is unresolved/);
    assert.equal(returned, false);
    await db.releaseClaim({ claimId: held!.id, generation: held!.generation }, { evidence: 'Exact owner stopped' }, host);
    await returnAttempt(db, discard, services);
    assert.equal(returned, true);
    assert.equal(db.attempt(a.attemptId).leaseState, 'returned');
    assert.equal(db.attempt(a.attemptId).outcome, 'failed');
    assert.equal(db.task('task').state, 'queued');
    assert.equal(db.task('task').holdReason, 'discarded');
  }
});

for (const proven of [true, false]) test(`R20/A40: failed preparation records zero only with never-started proof (${proven})`, async t => {
  const { db, started } = await fixture(t);
  await db.addObjective({ id: 'goal', request: 'Work', criteria: [], scope: '', constraints: '', permissions: null, budget: null, deadline: null }, person);
  const value = await started();
  await db.moveTask('task', db.task('task').definitionRevision, 'goal', person);
  const launcher = new FakeLauncher();
  launcher.beforePrepare = async () => proven ? rejected('No worker started', { neverStarted: true, currency: 'USD' }) : uncertain('Lost preparation');
  await prepareWorker(db, value.attemptId, host, launcher);
  const usage = db.objectiveUsage('goal');
  if (proven) {
    assert.deepEqual(usage.totals, { cost: 0, tokens: 0, workerTimeMs: 0 });
    assert.deepEqual(usage.gaps, []);
  } else {
    assert.equal(usage.totals.cost, null);
    assert.equal(usage.totals.tokens, null);
    assert.ok(usage.gaps.length);
  }
});

test('R20/A39: preparation registers its session before the launcher call and fixes current objective membership', async t => {
  const { db, started } = await fixture(t);
  await db.addObjective({ id: 'goal', request: 'Work', criteria: [], scope: '', constraints: '', permissions: null, budget: null, deadline: null }, person);
  const value = await started();
  await db.moveTask('task', db.task('task').definitionRevision, 'goal', person);
  const launcher = new FakeLauncher();
  const original = launcher.prepare.bind(launcher);
  launcher.prepare = async (binding, effectId) => {
    const session = db.events().find(e => e.kind === 'session.registered' && e.payload.sessionId === binding.sessionId)!;
    assert.equal(session.payload.objectiveId, 'goal');
    assert.equal(session.payload.kind, 'worker');
    return original(binding, effectId);
  };
  const prepared = await prepareWorker(db, value.attemptId, host, launcher);
  await db.moveTask('task', db.task('task').definitionRevision, null, person);
  await db.closeOrReopenObjective('goal', 'abandon', 'Finished', person);
  await db.recordUsage({ sessionId: String(prepared.input.sessionId), sourceSequence: 1, observedAt: new Date().toISOString(),
    cost: { availability: 'reported', value: 0, currency: 'USD' }, tokens: { availability: 'reported', input: 1, output: 2, total: 3 },
    workerTimeMs: { availability: 'reported', value: 1 } }, host);
  assert.equal(db.objectiveUsage('goal').totals.tokens, 3);
  assert.equal(db.events().filter(e => e.kind === 'session.registered').length, 1);
});

test('R06/R07/R08/R09: another connection records stop; only the owner fences, replay is inert and terminal evidence settles', async t => {
  const { db, path, options, prepared } = await fixture(t);
  const value = await prepared();
  const remote = await Database.open(path, options);
  defer(t, () => remote.close());
  const command = { requestKey: 'stop', operation: 'attempt.stop', caller: person,
    fingerprint: 'stop', input: { attemptId: value.attemptId, dryRun: false } };
  const before = state(db, path, value.attemptId);
  await remote.requestWorkerControl(command, true);
  assert.deepEqual(state(db, path, value.attemptId), before);
  await remote.requestWorkerControl(command);
  assert.equal(db.attempt(value.attemptId).outcome, null);
  assert.equal(db.attempt(value.attemptId).executionOpen, true);
  assert.equal(value.launcher.calls.filter(c => c.operation === 'fence').length, 0);
  assert.equal((await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host)).state, 'fenced');
  assert.equal(await activateWorker(db, value.attemptId, value.reference, host, value.launcher), null);
  await assert.rejects(controlWorker(db, value.attemptId, value.reference, { ...host, generation: 'other' }, value.launcher));
  await controlWorker(db, value.attemptId, value.reference, host, value.launcher);
  assert.equal(value.launcher.prompts.length, 0);
  assert.equal(value.launcher.calls.filter(c => c.operation === 'fence').length, 1);
  assert.equal(db.attempt(value.attemptId).outcome, null);
  await assert.rejects(db.interruptWorker(value.attemptId, host), conflict);
  await remote.requestWorkerControl(command);
  await controlWorker(db, value.attemptId, value.reference, host, value.launcher);
  assert.equal(value.launcher.calls.filter(c => c.operation === 'fence').length, 1);
  assert.equal(db.requests().filter(r => r.operation === 'worker.stop').length, 1);
  await db.recordWorkerObservation({ sourceId: host.id, sourceSequence: 1, attemptId: value.attemptId,
    workerRef: value.reference, observedAt: new Date().toISOString(), kind: 'terminal', payloadVersion: 1,
    payload: { turnEnded: true, threadStopped: true, fenceRecorded: true } }, host);
  assert.equal((await db.interruptWorker(value.attemptId, host)).outcome, 'interrupted');
  assert.equal(db.attempt(value.attemptId).executionOpen, false);
});

test('R06/R09: a stop recorded during allocation survives preparation and fences permission', async t => {
  const { db, allocated } = await fixture(t), value = await allocated();
  await db.requestWorkerControl({ requestKey: 'early-stop', operation: 'attempt.stop', caller: person,
    fingerprint: 'early-stop', input: { attemptId: value.attemptId, dryRun: false } });
  await db.startAttempt(value.attemptId, person);
  const launcher = new FakeLauncher();
  const prepared = await prepareWorker(db, value.attemptId, host, launcher);
  const reference = prepared.result!.reference as WorkerReference;
  assert.equal((await db.decideWorkerLaunch(value.attemptId, prepared.claimId!, 'permit', host)).state, 'fenced');
  await controlWorker(db, value.attemptId, reference, host, launcher);
  assert.equal(await activateWorker(db, value.attemptId, reference, host, launcher), null);
  assert.equal(launcher.prompts.length, 0);
});

test('R08/R09: an uncertain stop never repeats or supplies terminal evidence', async t => {
  const { db, prepared } = await fixture(t), value = await prepared();
  await db.requestWorkerControl({ requestKey: 'uncertain-stop', operation: 'attempt.stop', caller: person,
    fingerprint: 'uncertain-stop', input: { attemptId: value.attemptId, dryRun: false } });
  let calls = 0;
  value.launcher.fence = async () => { calls++; return uncertain('Lost fence acknowledgement'); };
  await assert.rejects(controlWorker(db, value.attemptId, value.reference, host, value.launcher));
  assert.equal(db.requests().find(r => r.operation === 'worker.stop')!.state, 'uncertain');
  await assert.rejects(controlWorker(db, value.attemptId, value.reference, host, value.launcher));
  await assert.rejects(db.interruptWorker(value.attemptId, host), conflict);
  assert.equal(calls, 1);
  assert.equal(db.attempt(value.attemptId).outcome, null);
  assert.equal(db.attempt(value.attemptId).executionOpen, true);
});

test('R06/R09: stop after permission but before activation prevents the initial prompt', async t => {
  const { db, prepared } = await fixture(t), value = await prepared();
  await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  await db.requestWorkerControl({ requestKey: 'late-stop', operation: 'attempt.stop', caller: person,
    fingerprint: 'late-stop', input: { attemptId: value.attemptId, dryRun: false } });
  assert.equal(await activateWorker(db, value.attemptId, value.reference, host, value.launcher), null);
  await controlWorker(db, value.attemptId, value.reference, host, value.launcher);
  assert.equal(value.launcher.prompts.length, 0);
});

function rows(path: string, attemptId: string) {
  using read = new DatabaseSync(path, { readOnly: true });
  return read.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId)!;
}
function state(db: Database, path: string, attemptId: string) {
  return { attempt: rows(path, attemptId), claims: db.claims(), requests: db.requests(), events: db.events(), tasks: db.tasks() };
}
function inject(db: Database, kind: string, afterEvent = false) {
  const target = db as unknown as { insertEvent: (event: EventInput) => unknown };
  const original = target.insertEvent;
  target.insertEvent = function (event) {
    if (event.kind === kind && !afterEvent) throw new Error('injected transaction failure');
    const result = original.call(this, event);
    if (event.kind === kind && afterEvent) throw new Error('injected transaction failure');
    return result;
  };
  return () => { target.insertEvent = original; };
}

for (const mode of ['', 'lost-ack', 'result']) test(`R31/R35/A14/A15: synthetic Pi honours the committed reference and permission (${mode || 'acknowledged'})`, async t => {
  const { db, root, started } = await fixture(t), value = await started('pi-task', 'other');
  await mkdir(value.allocation.path, { recursive: true });
  const record = join(root, 'pi-peer.jsonl');
  const launcher = new PiLauncher({ stateDirectory: join(root, 'pi-state'), requestMs: 2000,
    profiles: { test: { executable: process.execPath, entrypoint: resolve('tests/fixtures/pi-peer.ts'),
      credentialVariable: 'TEST_KEY', passEnvironment: ['PEER_RECORD', 'PEER_MODE'] } },
    environment: { PATH: process.env.PATH, PEER_RECORD: record, PEER_MODE: mode },
    admit: async (reference, input, effectId, generation) => {
      const effect = db.checkWorkerEffect(effectId, { claimId: value.claimId, generation });
      return effect.operation === 'worker.activate' && effect.attemptId === value.attemptId
        && JSON.stringify(effect.target!.reference) === JSON.stringify(reference)
        && JSON.stringify(effect.input.specification) === JSON.stringify(input);
    },
  });
  const prepared = await prepareWorker(db, value.attemptId, host, launcher);
  const reference = prepared.result!.reference as WorkerReference;
  defer(t, async () => { await launcher.fence(reference, 'cleanup'); });
  const records = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal((await records()).filter(r => r.type === 'prompt').length, 0);
  assert.equal(await activateWorker(db, value.attemptId, reference, host, launcher), null);
  await launcher.activate(reference, db.attempt(value.attemptId).specification, 'uncommitted-effect', host.generation);
  assert.equal((await records()).filter(r => r.type === 'prompt').length, 0);
  await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  assert.equal((await activateWorker(db, value.attemptId, reference, host, launcher))!.state, mode === 'lost-ack' ? 'uncertain' : 'succeeded');
  assert.equal(await activateWorker(db, value.attemptId, reference, host, launcher), null);
  assert.equal((await records()).filter(r => r.type === 'prompt').length, 1);
  if (mode === 'result') {
    await launcher.usage(reference); // Consume the result-written and turn-end frames.
    const prompt = (await records()).find(r => r.type === 'prompt');
    const protocol = JSON.parse(prompt.message.split('\n\n')[2]);
    const binding = db.workerResultBinding(value.attemptId);
    assert.equal(protocol.resultPath, join(root, 'attempts', value.attemptId, 'result.json'));
    assert.equal(protocol.resultPath, binding.resultPath);
    const transport = await launcher.result(reference);
    assert.equal(transport.status, 'confirmed');
    if (transport.status === 'confirmed') assert.equal(transport.value.reference.path, binding.resultPath);
    const result = await db.validateWorkerResult(value.attemptId, host, {
      compare: async () => confirmed(true), verifyRetention: async () => confirmed({ retained: true as const }),
    });
    assert.deepEqual(result.content, JSON.parse(await readFile(protocol.resultPath, 'utf8')));
    assert.equal(result.content.summary, 'Synthetic result');
  }
});

test('R05/A05: start rechecks definition and readiness, retaining allocation and newer person decisions', async t => {
  for (const change of ['definition', 'hold', 'done', 'dependency', 'newer-decision'] as const) {
    const f = await fixture(t), value = await f.allocated();
    if (change === 'definition' || change === 'newer-decision') await f.db.updateTaskDefinition('task', { title: 'Changed' }, person);
    if (change === 'hold' || change === 'newer-decision') await f.db.holdTask('task', 'Person hold', person);
    if (change === 'done') await f.db.markTaskDone('task', person);
    if (change === 'dependency') { await f.db.addTask({ id: 'blocker', title: 'Blocker' }, person); await f.db.addBlocker('task', 'blocker', person); }
    const decision = f.db.task('task');
    const result = await f.db.startAttempt(value.attemptId, person);
    assert.equal(result.outcome, 'held'); assert.equal(result.executionOpen, false); assert.equal(result.launchState, 'fenced');
    assert.deepEqual(result.allocation, value.allocation); assert.equal(result.leaseState, 'held');
    if (decision.decisionRevision > 0) assert.deepEqual(f.db.task('task'), decision);
    await assert.rejects(f.db.registerWorkerOwner(value.attemptId, host), conflict);
  }
});

test('R05: start verifies allocation, then captures current decision revision atomically; inputs freeze at start', async t => {
  const { db, path, allocated } = await fixture(t), { attemptId } = await allocated();
  using sql = new DatabaseSync(path);
  const original = rows(path, attemptId).allocation;
  sql.prepare("UPDATE attempts SET allocation = json_set(allocation, '$.startingCommit', ?) WHERE id = ?").run('b'.repeat(40), attemptId);
  const before = state(db, path, attemptId);
  await assert.rejects(db.startAttempt(attemptId, person), conflict);
  assert.deepEqual(state(db, path, attemptId), before);
  sql.prepare('UPDATE attempts SET allocation = ? WHERE id = ?').run(original as string, attemptId);
  await db.holdTask('task', 'Wait', person); await db.releaseTask('task', person);
  await db.startAttempt(attemptId, person);
  assert.equal(rows(path, attemptId).started_decision_revision, 2);
  assert.equal(db.task('task').state, 'in_flight');
  await assert.rejects(db.startAttempt(attemptId, person), conflict);
  const claimId = await db.registerWorkerOwner(attemptId, host);
  await prepareWorker(db, attemptId, host, new FakeLauncher());
  await db.updateTaskDefinition('task', { title: 'Later inputs' }, person);
  assert.equal((await db.decideWorkerLaunch(attemptId, claimId, 'permit', host)).state, 'permitted');
});

test('R06/R09/A10: preparation, binding and activation use shared requests and claims with a dispatch parent', async t => {
  const { db, path, prepared } = await fixture(t);
  const { attemptId, requestId, claimId, reference, launcher, prepare } = await prepared();
  assert.equal(launcher.prompts.length, 0);
  assert.equal(prepare.state, 'succeeded'); assert.equal(prepare.parentId, requestId); assert.equal(prepare.claimId, claimId);
  const spec = db.attempt(attemptId).specification;
  for (const key of ['databaseId', 'contextId', 'taskId', 'attemptId']) assert.equal(prepare.input[key], spec[key]);
  assert.deepEqual(prepare.input.allocation, db.attempt(attemptId).allocation);
  assert.deepEqual(prepare.input.owner, { claimId, generation: host.generation });
  assert.match(String(prepare.input.sessionId), /^[a-f0-9-]{36}$/);
  assert.match(String(prepare.input.profileDigest), /^[a-f0-9]{64}$/);
  assert.equal(db.claim(claimId).resourceKey, `worker:${attemptId}`);
  assert.deepEqual(await db.bindWorkerReference(attemptId, claimId, reference, host), reference);
  await assert.rejects(db.bindWorkerReference(attemptId, claimId, { ...reference, threadId: 'other' }, host), conflict);
  assert.deepEqual(await db.admitInitialBbPrompt(attemptId, String(reference.threadId), host), { kind: 'pending' });
  const decision = await db.decideWorkerLaunch(attemptId, claimId, 'permit', host);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'permit', host), conflict);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'fence', host), conflict);
  const activation = db.request(decision.effectId!);
  assert.equal(activation.parentId, requestId); assert.equal(activation.claimId, claimId);
  assert.deepEqual(activation.target, { kind: 'worker', reference });
  assert.equal((await activateWorker(db, attemptId, reference, host, launcher))!.state, 'succeeded');
  assert.equal(await activateWorker(db, attemptId, reference, host, launcher), null);
  assert.equal(launcher.prompts.length, 1);
  assert.deepEqual(launcher.prompts[0]!.input, db.attempt(attemptId).specification);
  assert.equal(rows(path, attemptId).runtime_ref, JSON.stringify(reference, Object.keys(reference).sort()));
  assert.ok(db.requests().every(request => request.category !== 'effect' || (request.parentId && request.claimId)));
});

test('R31: fake launcher contract separates preparation, activation, observation and terminal fencing', async t => {
  const { prepared } = await fixture(t), { reference, launcher } = await prepared();
  const before = await launcher.inspect(reference);
  assert.equal(before.status, 'known');
  if (before.status !== 'known') return;
  assert.equal(before.worker, 'prepared'); assert.equal(before.terminal, false);
  assert.equal(before.capabilities.preparation, 'non_acting');
  assert.equal((await launcher.stop(reference, 'stop')).status, 'confirmed');
  const stopped = await launcher.inspect(reference);
  assert.equal(stopped.status === 'known' && stopped.terminal, false);
  assert.equal((await launcher.fence(reference, 'fence')).status, 'confirmed');
  const fenced = await launcher.inspect(reference);
  assert.equal(fenced.status === 'known' && fenced.terminal, true);
  assert.ok(fenced.status === 'known' && fenced.sequence > before.sequence);
  assert.equal((await launcher.activate(reference, {}, 'later', host.generation)).status, 'rejected');
  assert.equal((await launcher.deliver(reference, 'No restart', 'after_turn', 'deliver')).status, 'rejected');
  assert.equal((await launcher.usage(reference)).status, 'unsupported');
  assert.equal((await launcher.result(reference)).status, 'rejected');
  assert.deepEqual(await launcher.inspect({ launcher: 'bb', threadId: 'absent' }), { status: 'absent' });
  assert.equal(launcher.prompts.length, 0);
});

test('R31: the shared lifecycle accepts a non-bb host reference and refuses a mismatched launcher', async t => {
  const { db, started, prepared } = await fixture(t);
  const first = await started('wrong');
  await db.beginWorkerPreparation(first.attemptId, first.claimId, host);
  await assert.rejects(db.bindWorkerReference(first.attemptId, first.claimId, { launcher: 'pi', sessionId: 'session', processId: '123' }, host), conflict);
  const second = await prepared('pi', 'other');
  await db.decideWorkerLaunch(second.attemptId, second.claimId, 'permit', host);
  assert.equal((await activateWorker(db, second.attemptId, second.reference, host, second.launcher))!.state, 'succeeded');
});

test('R06/R08/A13: recovery fencing survives owner heartbeat refresh and the paused creator never activates', async t => {
  const { db, path, options, prepared } = await fixture(t);
  const { attemptId, claimId, reference, launcher } = await prepared();
  using peer = await Database.open(path, options);
  await peer.fencePendingLaunch(attemptId, person);
  using sql = new DatabaseSync(path);
  sql.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', claimId);
  await db.heartbeatWorkerOwner(attemptId, claimId, host);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'permit', host), conflict);
  await assert.rejects(db.decideWorkerLaunch(attemptId, claimId, 'fence', host), conflict);
  assert.equal(await activateWorker(db, attemptId, reference, host, launcher), null);
  assert.equal(launcher.prompts.length, 0);
});

test('R06/R08: stale, future, missing and wrong-generation ownership cannot claim or call activation', async t => {
  for (const heartbeat of ['2020-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'malformed']) {
    const { db, path, prepared } = await fixture(t);
    const { attemptId, claimId, reference } = await prepared();
    const decision = await db.decideWorkerLaunch(attemptId, claimId, 'permit', host);
    using sql = new DatabaseSync(path);
    sql.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run(heartbeat, claimId);
    await assert.rejects(db.claimEffect(decision.effectId!, { claimId, generation: host.generation }), conflict);
    await assert.rejects(db.admitInitialBbPrompt(attemptId, String(reference.threadId), host), conflict);
    assert.equal(db.request(decision.effectId!).state, 'pending');
  }
  const { db, prepared } = await fixture(t), value = await prepared();
  const decision = await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  await assert.rejects(db.claimEffect(decision.effectId!, { claimId: value.claimId, generation: 'other' }), conflict);
  await assert.rejects(db.claimWorkerActivation(value.attemptId, value.reference, { ...host, generation: 'other' }), conflict);
  await db.claimEffect(decision.effectId!, { claimId: value.claimId, generation: host.generation });
  await db.releaseClaim({ claimId: value.claimId, generation: host.generation }, { stopped: true }, person);
  assert.throws(() => db.checkWorkerEffect(decision.effectId!, { claimId: value.claimId, generation: host.generation }), conflict);
});

test('R06/R09: directly claiming an activation effect still enforces permission and context owner freshness', async t => {
  const { db, path, prepared } = await fixture(t), value = await prepared();
  const decision = await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  using sql = new DatabaseSync(path);
  sql.prepare("UPDATE attempts SET launch_state = 'fenced' WHERE id = ?").run(value.attemptId);
  await assert.rejects(db.claimEffect(decision.effectId!, { claimId: value.claimId, generation: host.generation }), conflict);
});

test('R33: bb admission races claim exactly once and cannot admit another thread', async t => {
  const { db, path, options, prepared } = await fixture(t), value = await prepared();
  await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  await assert.rejects(db.admitInitialBbPrompt(value.attemptId, 'other', host), conflict);
  using peer = await Database.open(path, options);
  const result = await Promise.all([db.admitInitialBbPrompt(value.attemptId, String(value.reference.threadId), host),
    peer.admitInitialBbPrompt(value.attemptId, String(value.reference.threadId), host)]);
  assert.deepEqual(result.map(result => result.kind).sort(), ['admitted', 'already_admitted']);
});

test('R33: bb thread admission uses the full committed reference, including host resource identifiers', async t => {
  const { db, started } = await fixture(t), value = await started();
  await db.beginWorkerPreparation(value.attemptId, value.claimId, host);
  const reference = { launcher: 'bb', threadId: 'thread', environmentId: 'environment' };
  await db.bindWorkerReference(value.attemptId, value.claimId, reference, host);
  const decision = await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  assert.deepEqual(await db.admitInitialBbPrompt(value.attemptId, 'thread', host), { kind: 'admitted', effectId: decision.effectId });
  assert.deepEqual(db.request(decision.effectId!).target!.reference, reference);
});

test('A14/R09: uncertain prepare before or after creation is retained and never repeated', async t => {
  for (const stage of ['before', 'after', 'uncertain', 'rejected'] as const) {
    const { db, started } = await fixture(t), { attemptId } = await started(), launcher = new FakeLauncher();
    if (stage === 'before') launcher.beforePrepare = async () => { throw new Error('lost before create'); };
    else if (stage === 'rejected') launcher.beforePrepare = async () => rejected('Definite rejection', { owner: true });
    else launcher.afterPrepare = async reference => {
      if (stage === 'after') throw new Error('lost reply');
      return uncertain('Lost reply', reference);
    };
    if (stage === 'before' || stage === 'after') await assert.rejects(prepareWorker(db, attemptId, host, launcher));
    else await prepareWorker(db, attemptId, host, launcher);
    const effect = await prepareWorker(db, attemptId, host, launcher);
    assert.equal(effect.state, stage === 'rejected' ? 'rejected' : 'uncertain');
    assert.equal(launcher.calls.length, 1); assert.equal(launcher.prompts.length, 0);
  }
});

test('A14/R09: interrupted claimed prepare or activation is never retried, even before any adapter call', async t => {
  const { db, started, prepared } = await fixture(t), first = await started('prepare');
  const intent = await db.beginWorkerPreparation(first.attemptId, first.claimId, host);
  const launcher = new FakeLauncher();
  assert.equal((await prepareWorker(db, first.attemptId, host, launcher)).id, intent.effect.id);
  assert.equal(launcher.calls.length, 0);
  const second = await prepared('activate');
  const decision = await db.decideWorkerLaunch(second.attemptId, second.claimId, 'permit', host);
  await db.claimWorkerActivation(second.attemptId, second.reference, host);
  assert.equal(await activateWorker(db, second.attemptId, second.reference, host, second.launcher), null);
  assert.equal(db.request(decision.effectId!).state, 'claimed');
  assert.equal(second.launcher.prompts.length, 0);
});

test('A14/R09: lost activation responses before and after prompting never send twice', async t => {
  for (const stage of ['before', 'after', 'uncertain', 'rejected'] as const) {
    const { db, prepared } = await fixture(t), value = await prepared('task', 'other');
    await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
    if (stage === 'before') value.launcher.beforeActivate = async () => { throw new Error('lost before send'); };
    else if (stage === 'rejected') value.launcher.beforeActivate = async () => rejected('Not admitted', { owner: true });
    else value.launcher.afterActivate = async () => {
      if (stage === 'after') throw new Error('lost after send');
      return uncertain('No acknowledgement');
    };
    if (stage === 'before' || stage === 'after') await assert.rejects(activateWorker(db, value.attemptId, value.reference, host, value.launcher));
    else await activateWorker(db, value.attemptId, value.reference, host, value.launcher);
    assert.equal(await activateWorker(db, value.attemptId, value.reference, host, value.launcher), null);
    assert.equal(value.launcher.calls.filter(call => call.operation === 'activate').length, 1);
    assert.equal(value.launcher.prompts.length, stage === 'before' || stage === 'rejected' ? 0 : 1);
    const effect = db.requests().find(request => request.operation === 'worker.activate')!;
    assert.equal(effect.state, stage === 'rejected' ? 'rejected' : 'uncertain');
  }
});

test('A13: permission and recovery fence in independent processes have one irreversible winner', { timeout: 15000 }, async t => {
  for (const order of ['fence_first', 'permit_first', 'race']) {
    const { db, root, path, prepared } = await fixture(t), value = await prepared();
    const child = spawn(process.execPath, ['tests/helpers/launch-child.ts', path, root, value.attemptId, value.claimId],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const stopped = once(child, 'close');
    defer(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await stopped; });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    assert.deepEqual(ready[0], { ready: true });
    const exited = once(child, 'exit');
    const result = once(child, 'message');
    if (order === 'fence_first') await db.fencePendingLaunch(value.attemptId, person);
    child.send({ resume: true });
    if (order === 'permit_first') await result;
    let fenceWon = order === 'fence_first';
    if (order !== 'fence_first') {
      try { await db.fencePendingLaunch(value.attemptId, person); fenceWon = true; }
      catch (error) { assert.ok(conflict(error)); }
    }
    const [outcome] = await Promise.race([result, exited.then(() => { throw new Error(stderr || 'Child exited without a result'); })]) as [{ permitted: boolean; admitted: boolean }];
    assert.equal(outcome.permitted, !fenceWon); assert.equal(outcome.admitted, !fenceWon);
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(db.attempt(value.attemptId).launchState, fenceWon ? 'fenced' : 'permitted');
    await db.heartbeatWorkerOwner(value.attemptId, value.claimId, host);
    await assert.rejects(db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host), conflict);
  }
});

test('A10/R06: permission requires a committed matching reference and one reference cannot bind two attempts', async t => {
  const { db, started } = await fixture(t), first = await started('first'), second = await started('second');
  await assert.rejects(db.decideWorkerLaunch(first.attemptId, first.claimId, 'permit', host), conflict);
  const reference = { launcher: 'bb', threadId: 'shared' };
  await assert.rejects(db.bindWorkerReference(first.attemptId, first.claimId, reference, host), conflict);
  await db.beginWorkerPreparation(first.attemptId, first.claimId, host);
  await db.beginWorkerPreparation(second.attemptId, second.claimId, host);
  await db.bindWorkerReference(first.attemptId, first.claimId, reference, host);
  await assert.rejects(db.bindWorkerReference(second.attemptId, second.claimId, reference, host), conflict);
});

test('A14/R06: a recovery fence while prepare is paused prevents binding and every prompt', async t => {
  const { db, path, options, started } = await fixture(t), value = await started(), launcher = new FakeLauncher();
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  launcher.afterPrepare = async reference => { reached(); await resume; return { status: 'confirmed', value: reference }; };
  const preparing = prepareWorker(db, value.attemptId, host, launcher);
  const failure = assert.rejects(preparing, conflict);
  await paused;
  using peer = await Database.open(path, options);
  assert.equal(rows(path, value.attemptId).runtime_ref, null);
  assert.equal(launcher.prompts.length, 0);
  await peer.fencePendingLaunch(value.attemptId, person);
  release(); await failure;
  assert.equal((await prepareWorker(db, value.attemptId, host, launcher)).state, 'uncertain');
  assert.equal(rows(path, value.attemptId).runtime_ref, null);
  assert.equal(launcher.calls.length, 1); assert.equal(launcher.prompts.length, 0);
});

test('A14/R09: failed binding and failed activation confirmation preserve uncertainty without repeating either effect', async t => {
  const { db, started } = await fixture(t), value = await started('binding'), launcher = new FakeLauncher();
  let restore = inject(db, 'attempt.worker_bound');
  await assert.rejects(prepareWorker(db, value.attemptId, host, launcher), /injected/); restore();
  const uncertainPreparation = await prepareWorker(db, value.attemptId, host, launcher);
  assert.equal(uncertainPreparation.state, 'uncertain');
  const returnedReference = JSON.parse([...launcher.workers.keys()][0]!) as WorkerReference;
  assert.deepEqual(uncertainPreparation.result!.result, { status: 'confirmed', value: returnedReference });
  assert.match(String(uncertainPreparation.result!.reason), /injected/);
  assert.equal((await launcher.inspect(returnedReference)).status, 'known');
  assert.equal(launcher.calls.length, 1); assert.equal(launcher.prompts.length, 0);
  // An uncertain external effect blocks new admission in this context.
  assert.equal(db.requests().find(request => request.operation === 'worker.prepare')!.state, 'uncertain');
  const other = await fixture(t), active = await other.prepared();
  await other.db.decideWorkerLaunch(active.attemptId, active.claimId, 'permit', host);
  restore = inject(other.db, 'request.succeeded');
  await assert.rejects(activateWorker(other.db, active.attemptId, active.reference, host, active.launcher), /injected/); restore();
  assert.equal(await activateWorker(other.db, active.attemptId, active.reference, host, active.launcher), null);
  assert.equal(active.launcher.prompts.length, 1);
  assert.equal(other.db.requests().find(request => request.operation === 'worker.activate')!.state, 'uncertain');
});

test('R08/R09/A14: the executor rechecks freshness after claiming and immediately before both launcher calls', async t => {
  for (const operation of ['prepare', 'activate']) {
    const { db, path, started, prepared } = await fixture(t);
    const value = operation === 'prepare' ? { ...await started(), launcher: new FakeLauncher(), reference: { launcher: 'bb', threadId: 'unused' } } : await prepared('task', 'other');
    if (operation === 'activate') await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
    const original = db.checkWorkerEffect.bind(db);
    db.checkWorkerEffect = (id, identity) => {
      using sql = new DatabaseSync(path);
      sql.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', identity.claimId);
      return original(id, identity);
    };
    const call = operation === 'prepare' ? prepareWorker(db, value.attemptId, host, value.launcher)
      : activateWorker(db, value.attemptId, value.reference, host, value.launcher);
    await assert.rejects(call, conflict);
    assert.equal(value.launcher.calls.filter(call => call.operation === operation).length, 0);
    assert.equal(value.launcher.prompts.length, 0);
    assert.equal(db.requests().find(request => request.operation === `worker.${operation}`)!.state, 'uncertain');
  }
});

test('R09/R06: a different request key cannot authorise a second prepare or activation', async t => {
  const { db, prepared } = await fixture(t), value = await prepared();
  const decision = await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
  const effect = db.request(decision.effectId!);
  await assert.rejects(db.recordEffect({ requestKey: 'another-activation', operation: effect.operation, parentId: effect.parentId!,
    attemptId: value.attemptId, executor: { claimId: value.claimId, generation: host.generation }, caller: effect.caller,
    fingerprint: effect.fingerprint, input: effect.input, target: effect.target! }), conflict);
});

test('R31: unsupported preparation or admission refuses before claiming an effect or calling the launcher', async t => {
  const { db, started, prepared } = await fixture(t), value = await started('unsupported'), launcher = new FakeLauncher();
  const capabilities = launcher.capabilities({});
  launcher.capabilities = () => ({ ...capabilities, preparation: 'unsupported' });
  await assert.rejects(prepareWorker(db, value.attemptId, host, launcher), conflict);
  assert.equal(db.requests().filter(request => request.operation === 'worker.prepare').length, 0);
  const next = await prepared('supported');
  const decision = await db.decideWorkerLaunch(next.attemptId, next.claimId, 'permit', host);
  next.launcher.capabilities = () => ({ ...capabilities, admission: false });
  await assert.rejects(activateWorker(db, next.attemptId, next.reference, host, next.launcher), conflict);
  assert.equal(db.request(decision.effectId!).state, 'pending'); assert.equal(next.launcher.prompts.length, 0);
});

for (const operation of ['start', 'start_refused', 'owner', 'heartbeat', 'prepare', 'bind', 'permit', 'fence', 'recovery_fence', 'activation', 'outcome'] as const) for (const afterEvent of [false, true]) {
  test(`A09/R25: ${operation} rolls back on failure ${afterEvent ? 'after' : 'before'} its event`, async t => {
    const f = await fixture(t);
    const value = await f.allocated();
    let claimId = '', effectId = '', reference: WorkerReference = { launcher: 'bb', threadId: 'transaction' };
    if (operation !== 'start' && operation !== 'start_refused') await f.db.startAttempt(value.attemptId, person);
    if (!['start', 'start_refused', 'owner'].includes(operation)) claimId = await f.db.registerWorkerOwner(value.attemptId, host);
    if (['bind', 'permit', 'fence', 'activation', 'outcome'].includes(operation)) {
      const intent = await f.db.beginWorkerPreparation(value.attemptId, claimId, host); effectId = intent.effect.id;
    }
    if (['permit', 'activation', 'outcome'].includes(operation)) await f.db.bindWorkerReference(value.attemptId, claimId, reference, host);
    if (['activation', 'outcome'].includes(operation)) effectId = (await f.db.decideWorkerLaunch(value.attemptId, claimId, 'permit', host)).effectId!;
    if (operation === 'outcome') await f.db.claimWorkerActivation(value.attemptId, reference, host);
    if (operation === 'start_refused') await f.db.updateTaskDefinition('task', { title: 'Changed' }, person);
    const kind = { start: 'attempt.started', start_refused: 'attempt.start_refused', owner: 'attempt.owner_registered', heartbeat: 'claim.refreshed',
      prepare: 'request.claimed', bind: 'attempt.worker_bound', permit: 'attempt.launch_permitted', fence: 'attempt.launch_fenced',
      recovery_fence: 'attempt.launch_fenced', activation: 'attempt.prompt_admitted', outcome: 'request.succeeded' }[operation];
    const before = state(f.db, f.path, value.attemptId), restore = inject(f.db, kind, afterEvent);
    const call = () => {
      switch (operation) {
        case 'start': case 'start_refused': return f.db.startAttempt(value.attemptId, person);
        case 'owner': return f.db.registerWorkerOwner(value.attemptId, host);
        case 'heartbeat': return f.db.heartbeatWorkerOwner(value.attemptId, claimId, host);
        case 'prepare': return f.db.beginWorkerPreparation(value.attemptId, claimId, host);
        case 'bind': return f.db.bindWorkerReference(value.attemptId, claimId, reference, host);
        case 'permit': return f.db.decideWorkerLaunch(value.attemptId, claimId, 'permit', host);
        case 'fence': return f.db.decideWorkerLaunch(value.attemptId, claimId, 'fence', host);
        case 'recovery_fence': return f.db.fencePendingLaunch(value.attemptId, person);
        case 'activation': return f.db.claimWorkerActivation(value.attemptId, reference, host);
        case 'outcome': return f.db.recordEffectOutcome(effectId, { claimId, generation: host.generation }, 'succeeded', { admitted: true });
      }
    };
    await assert.rejects(call(), /injected transaction failure/); restore();
    assert.deepEqual(state(f.db, f.path, value.attemptId), before);
  });
}

async function bbDispatchFixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const f = await fixture(t), value = await f.started();
  const launcher = new FakeLauncher();
  const preparation = await prepareWorker(f.db, value.attemptId, host, launcher);
  const reference = preparation.result!.reference as WorkerReference;
  const member = { id: 'bb-generated-initial', author: 'user', content: String(preparation.input.initialInput) };
  return { ...f, ...value, launcher, reference, member, threadId: String(reference.threadId) };
}

test('R06 R33 R34 A14: unbound pending first prompt holds, unrelated text and authors pass through', async t => {
  const f = await fixture(t), value = await f.started();
  const launcher = new FakeLauncher();
  const prepare = launcher.prepare.bind(launcher);
  launcher.prepare = async (binding, effectId) => {
    const member = { id: 'bb-generated-before-bind', author: 'user', content: String(binding.initialInput) };
    assert.deepEqual(await f.db.admitBbDispatch('thr_unbound', [member]), { decision: 'hold' });
    assert.deepEqual(await f.db.admitBbDispatch('thr_unbound', [{ ...member, author: 'agent' }]), { decision: 'pass-through' });
    assert.deepEqual(await f.db.admitBbDispatch('thr_unbound', [{ ...member, content: `${member.content}changed` }]), { decision: 'pass-through' });
    return prepare(binding, effectId);
  };
  await prepareWorker(f.db, value.attemptId, host, launcher);
});

test('R06 R33 A15: bb hook holds before permission, matches every queued member and consumes admission once across reopen', async t => {
  const f = await bbDispatchFixture(t), { db, threadId, member } = f;
  assert.deepEqual(await db.admitBbDispatch('ordinary', [member]), { decision: 'pass-through' });
  assert.deepEqual(await db.admitBbDispatch(threadId, [member]), { decision: 'hold' });
  assert.deepEqual(await db.admitBbDispatch(threadId, [member, { ...member, id: 'unauthorised' }]), { decision: 'refuse' });
  const decision = await db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  for (const changed of [{ ...member, author: 'agent' }, { ...member, author: 'system' }, { ...member, content: 'forged' }]) {
    assert.deepEqual(await db.admitBbDispatch(threadId, [member, changed]), { decision: 'refuse' });
    assert.equal(db.request(decision.effectId!).state, 'pending');
    assert.deepEqual(await db.admitBbDispatch(threadId, [changed]), { decision: 'refuse' });
  }
  assert.deepEqual(await db.admitBbDispatch(threadId, [member, member]), { decision: 'refuse' });
  const peer = await Database.open(f.path, f.options); defer(t, () => peer.close());
  const admitted = await Promise.all([db.admitBbDispatch(threadId, [member]), peer.admitBbDispatch(threadId, [member])]);
  assert.deepEqual(admitted.map(r => r.decision).sort(), ['admit', 'refuse']);
  assert.equal(db.request(decision.effectId!).state, 'claimed');
  const reopened = await Database.open(f.path, f.options); defer(t, () => reopened.close());
  assert.deepEqual(await reopened.admitBbDispatch(threadId, [member]), { decision: 'refuse' });
});

test('R06 R33 A15: bb activation leaves consumption to the hook and queue re-evaluation never repeats on lost acknowledgement', async t => {
  for (const lost of [false, true]) {
    const f = await bbDispatchFixture(t), { db, member, threadId, launcher } = f;
    const decision = await db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
    launcher.admit = async () => {
      assert.equal(db.request(decision.effectId!).state, 'pending');
      assert.deepEqual(await db.admitBbDispatch(threadId, [member]), { decision: 'admit' });
      if (lost) throw new Error('lost hook acknowledgement');
      return true;
    };
    if (lost) await assert.rejects(activateWorker(db, f.attemptId, f.reference, host, launcher), /lost hook/);
    else assert.equal((await activateWorker(db, f.attemptId, f.reference, host, launcher))!.state, 'succeeded');
    assert.equal(db.request(decision.effectId!).state, lost ? 'uncertain' : 'succeeded');
    assert.equal(await activateWorker(db, f.attemptId, f.reference, host, launcher), null);
    assert.equal(launcher.calls.filter(c => c.operation === 'activate').length, 1);
    assert.deepEqual(await db.admitBbDispatch(threadId, [member]), { decision: 'refuse' });
  }
});

test('R06 R33 A15: later dispatch needs matching recorded deliveries for every member, with no replay', async t => {
  const f = await bbDispatchFixture(t), { db, threadId, member, reference } = f;
  const permission = await db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  assert.deepEqual(await db.admitBbDispatch(threadId, [member]), { decision: 'admit' });
  const executor = { claimId: f.claimId, generation: host.generation };
  await db.recordEffectOutcome(permission.effectId!, executor, 'succeeded', { admitted: true });
  const next = { id: 'bb-generated-later', author: 'user', content: 'Continue with the recorded steer' };
  assert.deepEqual(await db.admitBbDispatch(threadId, [next]), { decision: 'refuse' });
  const input = { attemptId: f.attemptId, message: next.content, mode: 'after_turn' };
  const command = await db.recordCommand({ requestKey: 'later-command', operation: 'attempt.steer', caller: person,
    input, fingerprint: canonicalJson(input) });
  const effect = await db.recordEffect({ requestKey: 'later-effect', operation: 'worker.deliver', caller: person,
    input: { reference, ...input }, fingerprint: 'later', parentId: command.id,
    executor, attemptId: f.attemptId, target: { kind: 'worker', reference } });
  await db.claimEffect(effect.id, executor);
  for (const changed of [{ ...next, id: 'other', author: 'agent' }, { ...next, id: 'other', author: 'system' }, { ...next, id: 'other', content: 'bad' }]) {
    assert.deepEqual(await db.admitBbDispatch(threadId, [next, changed]), { decision: 'refuse' });
  }
  assert.deepEqual(await db.admitBbDispatch(threadId, [next]), { decision: 'admit' });
  assert.deepEqual(await db.admitBbDispatch(threadId, [next]), { decision: 'refuse' });
  const terminalMember = { ...next, id: 'terminal' };
  const pending = await db.recordEffect({ requestKey: 'terminal-delivery', operation: 'worker.deliver', caller: person,
    input: { reference, ...input }, fingerprint: 'terminal',
    parentId: command.id, executor, attemptId: f.attemptId, target: { kind: 'worker', reference } });
  await db.claimEffect(pending.id, executor);
  await db.recordWorkerObservation({ sourceId: host.id, sourceSequence: 1, attemptId: f.attemptId, workerRef: reference,
    observedAt: new Date().toISOString(), kind: 'terminal', payloadVersion: 1,
    payload: { turnEnded: true, threadStopped: true, fenceRecorded: true } }, host);
  assert.deepEqual(await db.admitBbDispatch(threadId, [terminalMember]), { decision: 'refuse' });
});

test('R06 R33 A15: an identical first copy consumes activation in place of the recorded send', async t => {
  const f = await bbDispatchFixture(t);
  const copy = { ...f.member, id: 'copy-arrived-first' };
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [copy]), { decision: 'hold' });
  await f.db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [copy, f.member]), { decision: 'refuse' });
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [copy]), { decision: 'admit' });
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [f.member]), { decision: 'refuse' });
});

test('R06 R33 A15: two identical recorded deliveries admit two members, grouped mismatch consumes neither', async t => {
  const f = await bbDispatchFixture(t), { db, threadId, reference } = f;
  const permission = await db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  await db.admitBbDispatch(threadId, [f.member]);
  const executor = { claimId: f.claimId, generation: host.generation };
  await db.recordEffectOutcome(permission.effectId!, executor, 'succeeded', { admitted: true });
  const input = { attemptId: f.attemptId, message: 'Identical authorised text', mode: 'after_turn' };
  for (const index of [1, 2]) {
    const command = await db.recordCommand({ requestKey: `same-command-${index}`, operation: 'attempt.steer', caller: person,
      input, fingerprint: canonicalJson(input) });
    const effect = await db.recordEffect({ requestKey: `same-effect-${index}`, operation: 'worker.deliver', caller: person,
      input: { reference, ...input }, fingerprint: 'same', parentId: command.id,
      executor, attemptId: f.attemptId, target: { kind: 'worker', reference } });
    await db.claimEffect(effect.id, executor);
  }
  const members = [1, 2].map(index => ({ id: `bb-copy-${index}`, author: 'user', content: input.message }));
  for (const invalid of [{ ...members[1]!, content: 'unrecorded' }, { ...members[1]!, author: 'agent' }]) {
    assert.deepEqual(await db.admitBbDispatch(threadId, [members[0]!, invalid]), { decision: 'refuse' });
    assert.equal(db.events().filter(e => e.kind === 'worker.delivery_admitted').length, 0);
  }
  assert.deepEqual(await db.admitBbDispatch(threadId, [...members, { ...members[0]!, id: 'third' }]), { decision: 'refuse' });
  const restore = inject(db, 'worker.delivery_admitted', true);
  try { await assert.rejects(db.admitBbDispatch(threadId, members), /injected transaction failure/); }
  finally { restore(); }
  assert.equal(db.events().filter(e => e.kind === 'worker.delivery_admitted').length, 0);
  assert.deepEqual(await db.admitBbDispatch(threadId, members), { decision: 'admit' });
  assert.equal(db.events().filter(e => e.kind === 'worker.delivery_admitted').length, 2);
  assert.deepEqual(await db.admitBbDispatch(threadId, [{ ...members[0]!, id: 'original-arrives-later' }]), { decision: 'refuse' });
});

test('R06 R33 A15: stale owners and fenced workers refuse hook admission without consuming activation', async t => {
  for (const fenced of [false, true]) {
    const f = await bbDispatchFixture(t);
    if (fenced) await f.db.decideWorkerLaunch(f.attemptId, f.claimId, 'fence', host);
    else {
      await f.db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
      const raw = new DatabaseSync(f.path); defer(t, () => raw.close());
      raw.prepare('UPDATE claims SET heartbeat_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', f.claimId);
    }
    assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [f.member]), { decision: 'refuse' });
  }
});

test('R06 R33 A15: a queue acknowledgement without hook admission stays uncertain and is never re-evaluated twice', async t => {
  const f = await bbDispatchFixture(t);
  const permission = await f.db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  f.launcher.beforeActivate = async () => confirmed({ queued: true });
  assert.equal((await activateWorker(f.db, f.attemptId, f.reference, host, f.launcher))!.state, 'uncertain');
  assert.equal(f.db.request(permission.effectId!).state, 'pending');
  assert.equal(await activateWorker(f.db, f.attemptId, f.reference, host, f.launcher), null);
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [f.member]), { decision: 'refuse' });
  assert.equal(f.launcher.calls.filter(c => c.operation === 'activate').length, 1);
});

for (const afterEvent of [false, true]) test(`R06 R33 A15: hook admission rolls back activation consumption with its event (${afterEvent})`, async t => {
  const f = await bbDispatchFixture(t);
  const permission = await f.db.decideWorkerLaunch(f.attemptId, f.claimId, 'permit', host);
  const restore = inject(f.db, 'attempt.prompt_admitted', afterEvent);
  try { await assert.rejects(f.db.admitBbDispatch(f.threadId, [f.member]), /injected transaction failure/); }
  finally { restore(); }
  assert.equal(f.db.request(permission.effectId!).state, 'pending');
  assert.deepEqual(await f.db.admitBbDispatch(f.threadId, [f.member]), { decision: 'admit' });
});
