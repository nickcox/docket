import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configuration } from '../fixtures/configuration.ts';
import { Database, applicationId } from '../../src/storage/database.ts';
import { userInfo } from 'node:os';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      // SQLite may create transient WAL coordination files even on a read-only
      // connection. They contain no new domain writes and are not artefacts.
      if (/\.db-(wal|shm)$/u.test(entry.name)) continue;
      if (entry.isDirectory()) { files[file] = 'directory'; await visit(file); }
      else if (entry.isFile()) files[file] = (await readFile(file)).toString('base64');
    }
  };
  await visit(root); return files;
}
const entry = fileURLToPath(new URL('../../bin/docket.ts', import.meta.url));
const peer = fileURLToPath(new URL('../fixtures/pi-peer.ts', import.meta.url));
async function fixture(t: test.TestContext, mode = 'code-result') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-operations-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'repository'); await mkdir(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Tests'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'README'), 'Base\n'); git('add', '.'); git('commit', '-qm', 'Base');
  const config = configuration(home); config.repository = repo;
  config.profiles.worker.launcher = 'pi'; config.profiles.worker.executionProfile = 'pi-test'; config.profiles.worker.runMs = 10000;
  config.finalisation.kind = 'local-merge';
  const file = join(home, 'context.json'); await writeFile(file, JSON.stringify(config));
  await mkdir(join(home, '.config', 'docket'), { recursive: true });
  await writeFile(join(home, '.config', 'docket', 'execution-profiles.json'), JSON.stringify({ version: 1,
    pi: { 'pi-test': { executable: process.execPath, entrypoint: peer, passEnvironment: ['PEER_MODE', 'PEER_RECORD'] } },
    checks: { 'node-project-v1': { id: 'node-project-v1', tools: { node: process.version }, dependencies: {} } } }), { mode: 0o600 });
  const invoke = (operation: string, args: object, key?: string) => {
    const result = spawnSync(process.execPath, [entry, ...operation.split('.'), '--config', file, '--stdin', '--json', ...(key ? ['--request-id', key] : [])], {
      encoding: 'utf8', input: JSON.stringify(args), timeout: 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PEER_MODE: mode, PEER_RECORD: join(home, 'peer.jsonl') },
    });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.stdout.split('\n').length, 2, result.stdout);
    const envelope = JSON.parse(result.stdout);
    if (envelope.outcome === 'succeeded') assert.equal(validateSchema(findOperation(operation)!.outputSchema, envelope.data), null, operation);
    return { ...result, envelope, data: envelope.data };
  };
  assert.equal(invoke('context.init', {}).status, 0);
  return { home, repo, git, config, invoke, file };
}
const definition = { title: 'Implement feature', instructions: 'Implement the feature', criteria: ['Works'], kind: 'code', profile: null };

test('M3/R27/R30: real CLI adds, plans, dispatches synthetic Pi, accepts local-merge and returns its lease', async t => {
  const f = await fixture(t);
  const add = f.invoke('task.add', { id: 'feature', definition, objectiveId: null }, 'add');
  assert.equal(add.status, 0, JSON.stringify(add.envelope));
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }, 'add').status, 0);
  const before = await snapshot(f.home);
  const plan = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.deepEqual(await snapshot(f.home), before);
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope) + dispatched.stderr);
  assert.deepEqual(dispatched.data.steps, plan.data.steps);
  for (const entry of plan.data.steps) assert.ok(dispatched.stderr.includes(entry.operation));
  const attempt = dispatched.data.attempt;
  assert.equal(attempt.outcome, 'completed'); assert.equal(attempt.executionOpen, false);
  assert.equal(f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch').data.attempt.id, attempt.id);
  const acceptArgs = { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: true };
  const bytes = await snapshot(f.home);
  const acceptancePlan = f.invoke('attempt.accept', acceptArgs);
  assert.equal(acceptancePlan.status, 0, JSON.stringify(acceptancePlan.envelope));
  assert.deepEqual(await snapshot(f.home), bytes);
  const accepted = f.invoke('attempt.accept', { ...acceptArgs, dryRun: false }, 'accept');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.deepEqual(accepted.data.steps, acceptancePlan.data.steps);
  assert.equal(f.git('rev-parse', 'main'), attempt.candidate.commit);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, noProcesses: true, dryRun: false }, 'return');
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('task.show', { taskId: 'feature' }).data.task.state, 'done');
  const records = (await readFile(join(f.home, 'peer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.type === 'prompt').length, 1);
});

test('R11: CLI discards terminal missing/invalid output, refuses dirty work and frees capacity after the exact lease returns', async t => {
  for (const mode of ['missing-result', 'invalid-result']) {
    const f = await fixture(t, mode);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    const failed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
    assert.equal(failed.envelope.code, 'result_invalid');
    const attemptId = failed.data.attemptId;
    assert.ok(attemptId);
    const before = f.invoke('attempt.show', { attemptId }).data;
    assert.equal(before.outcome, null); assert.equal(before.executionOpen, true);
    const discard = { attemptId, confirmDiscard: true, noProcesses: true, reason: 'Result is unusable', dryRun: false };
    const dirty = join(before.allocation.path, 'untracked');
    await writeFile(dirty, 'Keep this work');
    assert.equal(f.invoke('attempt.discard', discard).envelope.code, 'workspace_dirty');
    assert.equal(f.invoke('attempt.show', { attemptId }).data.outcome, null);
    await rm(dirty);
    const returned = f.invoke('attempt.discard', discard, 'discard');
    assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
    assert.equal(returned.data.attempt.outcome, 'failed');
    assert.equal(returned.data.attempt.executionOpen, false);
    assert.equal(returned.data.attempt.leaseState, 'returned');
    assert.equal(f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data.capacity.used, 0);
  }
});

test('A16/A49/R30: stale claim and uncertain effect block dispatch until scoped person resolutions; plans do not write', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const options = { readOnly: false, location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } };
  const db = await Database.open(f.config.databasePath, options);
  const person = { kind: 'person' as const, id: String(userInfo().uid) };
  const [claim] = await db.registerClaims([{ resourceKey: 'owner', role: 'maintenance', generation: 'test-generation', ownerRef: person,
    schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], person);
  const command = await db.recordCommand({ requestKey: 'original', operation: 'original', caller: person, fingerprint: 'original', input: {} });
  const executor = { claimId: claim!.id, generation: claim!.generation };
  const effect = await db.recordEffect({ requestKey: 'uncertain', operation: 'worker.test', caller: person, fingerprint: 'effect', input: {},
    parentId: command.id, executor, target: { kind: 'worker', reference: { launcher: 'pi', ownerId: 'lost-owner' } } });
  await db.claimEffect(effect.id, executor);
  await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: 'Lost response' });
  await db.refreshClaim(executor, new Date(Date.now() - 60000).toISOString(), person);
  db.close();
  const dispatch = () => f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: true });
  assert.equal(dispatch().status, 1);
  const resolve = { claimId: claim!.id, evidence: 'Inspected the exact owner and stopped its processes', confirmStopped: true, dryRun: true };
  assert.equal(f.invoke('claim.resolve', { ...resolve, confirmStopped: false }).envelope.code, 'process_confirmation_required');
  const bytes = await readFile(f.config.databasePath);
  assert.equal(f.invoke('claim.resolve', resolve).status, 0);
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  assert.equal(dispatch().status, 1, 'age and a plan are not proof');
  assert.equal(f.invoke('claim.resolve', { ...resolve, dryRun: false }, 'resolve-claim').status, 0);
  assert.equal(dispatch().status, 1, 'the uncertain effect still blocks');
  const effectArgs = { effectId: effect.id, outcome: 'not_happened', evidence: 'Exact owner inspected; no activation was sent', confirmStopped: true, dryRun: false };
  assert.equal(f.invoke('effect.resolve', { ...effectArgs, evidence: ' ' }).status, 2);
  assert.equal(f.invoke('effect.resolve', effectArgs, 'resolve-effect').status, 0);
  assert.equal(f.invoke('effect.resolve', effectArgs, 'resolve-effect').status, 0, 'resolution is replayable');
  assert.equal(dispatch().status, 0);
});

test('R28/R27: strict task inputs, mutations, revisions, replay and paginated reads share one envelope', async t => {
  const f = await fixture(t);
  for (const id of ['first', 'second']) assert.equal(f.invoke('task.add', { id, definition, objectiveId: null }).status, 0);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Wait', caller: 'person' }).status, 2);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Wait' }, 'hold').status, 0);
  assert.equal(f.invoke('task.hold', { taskId: 'first', reason: 'Changed' }, 'hold').envelope.code, 'request_input_mismatch');
  assert.equal(f.invoke('task.release', { taskId: 'first' }).status, 0);
  assert.equal(f.invoke('task.block', { taskId: 'first', blockerId: 'second' }).status, 0);
  assert.equal(f.invoke('task.show', { taskId: 'first' }).data.task.ready, false);
  assert.equal(f.invoke('task.unblock', { taskId: 'first', blockerId: 'second' }).status, 0);
  assert.equal(f.invoke('task.reorder', { orderedTaskIds: ['second', 'first'] }).status, 0);
  assert.equal(f.invoke('task.done', { taskId: 'first', note: 'Person judgement' }).status, 0);
  assert.equal(f.invoke('task.reopen', { taskId: 'first', note: null }).status, 0);
  assert.equal(f.invoke('task.add', { id: 'review', definition: { ...definition, kind: 'review' }, objectiveId: null }).status, 2);
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 1, definition: { ...definition, kind: 'review' } }).status, 1);
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 99, definition }).envelope.code, 'task_changed');
  assert.equal(f.invoke('task.update', { taskId: 'first', expectedRevision: 1, definition: { ...definition, title: 'New title' } }).status, 0);
  const page = f.invoke('task.list', { state: null, readyOnly: false, page: { after: null, limit: 1 } });
  assert.equal(page.data.items[0].id, 'second'); assert.equal(page.data.next, 'second');
});
