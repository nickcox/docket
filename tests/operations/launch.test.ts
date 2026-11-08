import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applicationId, Database, StorageError } from '../../src/storage/database.ts';
import type { EventInput, JsonObject } from '../../src/storage/database.ts';
import type { WorkerHost, WorkerReference } from '../../src/storage/launch.ts';
import type { Allocation } from '../../src/storage/reservations.ts';
import { activateWorker, prepareWorker } from '../../src/workers.ts';
import { rejected, uncertain } from '../../src/adapters/command.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';

const person = { kind: 'person' as const, id: 'operator' };
const host: WorkerHost = { kind: 'host', id: 'backend', generation: 'generation-1' };
const conflict = (error: unknown) => error instanceof StorageError && error.code === 'conflict';
const hash = 'a'.repeat(40);

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.after(() => db.close());
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
    return { ...value, launcher, prepare: effect, reference: effect.result!.reference as WorkerReference };
  }
  return { db, root, path, options, allocated, started, prepared };
}

function rows(path: string, attemptId: string) {
  using read = new DatabaseSync(path, { readOnly: true });
  return read.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId)!;
}
function state(db: Database, path: string, attemptId: string) {
  return { attempt: rows(path, attemptId), claims: db.claims(), requests: db.requests(), events: db.events(), tasks: db.tasks() };
}
function inject(db: Database, kind: string) {
  const target = db as unknown as { insertEvent: (event: EventInput) => unknown };
  const original = target.insertEvent;
  target.insertEvent = function (event) {
    if (event.kind === kind) throw new Error('injected transaction failure');
    return original.call(this, event);
  };
  return () => { target.insertEvent = original; };
}

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

test('A14/R09: uncertain prepare before or after creation is retained and never repeated', async t => {
  for (const stage of ['before', 'after', 'uncertain', 'rejected'] as const) {
    const { db, started } = await fixture(t), { attemptId } = await started(), launcher = new FakeLauncher();
    if (stage === 'before') launcher.beforePrepare = async () => { throw new Error('lost before create'); };
    else launcher.afterPrepare = async reference => {
      if (stage === 'after') throw new Error('lost reply');
      return stage === 'rejected' ? rejected('Definite rejection', { owner: true }) : uncertain('Lost reply', reference);
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
    const { db, prepared } = await fixture(t), value = await prepared();
    await db.decideWorkerLaunch(value.attemptId, value.claimId, 'permit', host);
    if (stage === 'before') value.launcher.beforeActivate = async () => { throw new Error('lost before send'); };
    else value.launcher.afterActivate = async () => {
      if (stage === 'after') throw new Error('lost after send');
      return stage === 'uncertain' ? uncertain('No acknowledgement') : rejected('Not admitted', { owner: true });
    };
    if (stage === 'before' || stage === 'after') await assert.rejects(activateWorker(db, value.attemptId, value.reference, host, value.launcher));
    else await activateWorker(db, value.attemptId, value.reference, host, value.launcher);
    assert.equal(await activateWorker(db, value.attemptId, value.reference, host, value.launcher), null);
    assert.equal(value.launcher.calls.filter(call => call.operation === 'activate').length, 1);
    assert.equal(value.launcher.prompts.length, stage === 'before' ? 0 : 1);
    const effect = db.requests().find(request => request.operation === 'worker.activate')!;
    assert.equal(effect.state, stage === 'rejected' ? 'rejected' : 'uncertain');
  }
});

test('A13: permission and recovery fence in independent processes have one irreversible winner', { timeout: 15000 }, async t => {
  for (const fenceFirst of [true, false]) {
    const { db, root, path, prepared } = await fixture(t), value = await prepared();
    const child = spawn(process.execPath, ['tests/helpers/launch-child.ts', path, root, value.attemptId, value.claimId],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { child.kill(); });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    assert.deepEqual(ready[0], { ready: true });
    const exited = once(child, 'exit');
    const result = once(child, 'message');
    if (fenceFirst) await db.fencePendingLaunch(value.attemptId, person);
    child.send({ resume: true });
    let fenceWon = fenceFirst;
    if (!fenceFirst) {
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

for (const operation of ['start', 'start_refused', 'owner', 'heartbeat', 'prepare', 'bind', 'permit', 'fence', 'recovery_fence', 'activation', 'outcome'] as const) {
  test(`A09/R25: ${operation} and its events roll back together on an injected failure`, async t => {
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
    const before = state(f.db, f.path, value.attemptId), restore = inject(f.db, kind);
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
