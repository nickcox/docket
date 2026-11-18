import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialiseContext, openContext } from '../../src/context.ts';
import { createRuntime } from '../../src/runtime.ts';
import { executeCoreOperation } from '../../src/operations.ts';
import { findOperation } from '../../src/catalog.ts';
import { CommandFailure } from '../../src/response.ts';
import type { WorkerReference } from '../../src/storage/launch.ts';
import { applicationId } from '../../src/storage/database.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { prepareWorker, observeWorker } from '../../src/workers.ts';
import { confirmed, type Runner } from '../../src/adapters/command.ts';
import { configuration } from '../fixtures/configuration.ts';
import { defer } from '../helpers/cleanup.ts';
import { person, host, start, head, retention } from '../helpers/check-attempt.ts';

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-bb-readonly-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json'), config = configuration(home);
  await writeFile(file, JSON.stringify(config));
  await initialiseContext({ config: file }, { home, recyclableRoots: [], caller: person });
  const context = await openContext({ config: file }, { home, readOnly: false });
  defer(t, () => context.database.close());
  const db = context.database;
  const profilesPath = join(home, '.config', 'docket', 'execution-profiles.json');
  await mkdir(dirname(profilesPath), { recursive: true });
  await writeFile(profilesPath, JSON.stringify({ version: 1, pi: {},
    bb: { 'bb-worker-v1': { executable: process.execPath, passEnvironment: [], projectId: 'proj_test' } },
    checks: { 'node-project-v1': { id: 'node-project-v1', tools: {}, dependencies: {} } } }), { mode: 0o600 });
  let unreadable = false;
  const events = [
    { threadId: 'thr_worker', seq: 1, type: 'turn/started', data: {} },
    { threadId: 'thr_worker', seq: 2, type: 'turn/completed', data: {} },
  ];
  let path = '';
  const calls: string[][] = [];
  const run: Runner = async (_executable, args) => {
    calls.push(args);
    let value: unknown;
    if (args[0] === 'docket') value = { version: 1, ready: true };
    else if (args[1] === 'spawn') value = { id: 'thr_worker' };
    else if (args[1] === 'show') value = { thread: { id: 'thr_worker', providerId: 'test-provider', status: 'idle' }, environment: { path } };
    else if (args[1] === 'log') value = events;
    else throw new Error('Unexpected bb effect');
    return { complete: true, code: 0, stdout: unreadable && args[1] === 'log' ? '{' : JSON.stringify(value), stderr: '' };
  };
  const runtime: typeof createRuntime = (database, resolved) => createRuntime(database, resolved, home,
    { bbRun: run, windowsSettingsWritableOnlyByOwner: async () => true });
  await db.addTask({ id: 'worker', title: 'Worker', kind: 'code', criteria: ['Works'] }, person);
  const reservation = await db.reserveAttempt({ requestKey: 'reserve', taskId: 'worker', caller: person, startingCommit: start,
    checks: parseCheckPolicy(start, null, config.checks),
    delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
  const id = reservation.attempt.id;
  const [owner] = await db.registerClaims([{ resourceKey: 'dispatch', role: 'maintenance', generation: 'dispatch', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const executor = { claimId: owner!.id, generation: owner!.generation };
  const acquisition = await db.beginWorkspaceAcquisition(id, reservation.requestId, executor, person);
  const input = acquisition.effect.input, workspace = input.workspace as Record<string, any>;
  path = join(String(workspace.pool), 'worker');
  await db.recordAllocation(id, acquisition.effect.id, executor, { leaseId: 'lease', holder: workspace.holder,
    path, pool: String(workspace.pool), repository: input.repository as Record<string, any>,
    outputRef: String(input.outputRef), startingCommit: start });
  await db.startAttempt(id, person);
  const services = await runtime(db, context.configuration.resolved);
  const preparation = await prepareWorker(db, id, host, services.launcher);
  await db.decideWorkerLaunch(id, preparation.claimId!, 'permit', host);
  const binding = db.workerResultBinding(id), reference = preparation.result!.reference as WorkerReference;
  await writeFile(binding.resultPath, JSON.stringify({ version: 1, identity: binding.identity, startingCommit: start,
    outputRef: binding.outputRef, outcome: 'completed', summary: 'Implemented', reason: null,
    criteriaReport: [{ position: 1, criterion: 'Works', status: 'met', evidence: 'Tested' }], evidence: [],
    workReferences: [{ kind: 'git', name: 'code', branch: binding.outputRef, commit: head }] }));
  const observation = { sourceId: 'bb:thr_worker', attemptId: id, workerRef: reference,
    observedAt: new Date().toISOString(), payloadVersion: 1 as const };
  await observeWorker(db, { ...observation, sourceSequence: 2, kind: 'result_available', payload: {} }, host, retention);
  await observeWorker(db, { ...observation, sourceSequence: 3, kind: 'terminal',
    payload: { turnEnded: true, threadStopped: true, fenceRecorded: true } }, host, retention);
  const activation = db.requests({ attemptId: id, operation: 'worker.activate' })[0]!;
  await db.closePendingEffect(activation.id, 'withdrawn', { reason: 'Synthetic worker is already terminal' }, person);
  events.push({ threadId: 'thr_worker', seq: 4, type: 'turn/started', data: {} });
  const execute = (name: string, args: Record<string, unknown>) => executeCoreOperation(findOperation(name)!, args,
    () => {}, { config: file }, `test-${name}`, { home, caller: person, runtime });
  const accept = (dryRun: boolean) => execute('attempt.accept', { attemptId: id, candidateCommit: null, overrideReason: null, dryRun });
  const status = async () => {
    const result = await execute('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
    return (result.attempts as { items: any[] }).items.find(a => a.id === id);
  };
  return { db, id, calls, accept, status, unreadable: () => { unreadable = true; } };
}

const refusal = (expected: string) => (error: unknown) => error instanceof CommandFailure && error.code === expected;

test('R11 R33 A55: read-only acceptance and status detect an unrecorded later bb turn without writing; writable acceptance records it', async t => {
  const f = await fixture(t), before = { events: f.db.events(), requests: f.db.requests(), claims: f.db.claims(), attempt: f.db.attempt(f.id) };
  await assert.rejects(f.accept(true), refusal('result_discrepancy'));
  const transient = await f.status();
  assert.match(transient.reason, /result_discrepancy: A later worker turn was observed/);
  assert.equal(transient.nextAction.operation, 'attempt.show');
  assert.match(transient.nextAction.description, /select a candidate explicitly.*person.*discard/i);
  assert.deepEqual({ events: f.db.events(), requests: f.db.requests(), claims: f.db.claims(), attempt: f.db.attempt(f.id) }, before);
  await assert.rejects(f.accept(false), refusal('result_discrepancy'));
  const later = f.db.events({ attemptId: f.id, kinds: ['worker.observed'] }).filter(e => e.payload.kind === 'later_turn');
  assert.equal(later.length, 1);
  assert.equal(later[0]!.payload.sourceSequence, 4);
  const recorded = await f.status();
  assert.equal(transient.reason, recorded.reason);
  assert.deepEqual(transient.nextAction, recorded.nextAction);
  await assert.rejects(f.accept(false), refusal('result_discrepancy'));
  assert.equal(f.db.events({ attemptId: f.id, kinds: ['worker.observed'] }).filter(e => e.payload.kind === 'later_turn').length, 1);
  assert.ok(f.calls.every(args => ['show', 'log', 'spawn'].includes(args[1]!) || args[0] === 'docket'));
});

test('R11 R33 A55: an unreadable bb log remains owner_unknown rather than a later-turn discrepancy', async t => {
  const f = await fixture(t), before = f.db.events();
  f.unreadable();
  await assert.rejects(f.accept(true), refusal('owner_unknown'));
  await assert.rejects(f.accept(false), refusal('owner_unknown'));
  const status = await f.status();
  assert.equal(status.reason, "The owner's current state is unknown.");
  assert.deepEqual(f.db.events(), before);
});
