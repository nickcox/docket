import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { configuration } from '../fixtures/configuration.ts';
import { Database, applicationId } from '../../src/storage/database.ts';
import { DatabaseSync } from 'node:sqlite';
import { parseConfiguration } from '../../src/configuration.ts';
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
// Repository initialisation is not a CLI boundary. Copy an immutable seed so
// each test still has independent refs, index, configuration and worktree files.
let seed: string;
before(async () => {
  seed = await realpath(await mkdtemp(join(tmpdir(), 'docket-git-seed-')));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: seed, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Tests');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'README'), 'Base\n');
  git('add', '.'); git('commit', '-qm', 'Base');
});
after(() => rm(seed, { recursive: true, force: true }));

async function fixture(t: test.TestContext, mode = 'code-result') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-operations-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    // Windows PowerShell's settings ACL probe initialises AppData\Roaming under
    // USERPROFILE even with -NoProfile. A real Windows profile already has these
    // folders; create them before snapshots so every other home write is detected.
    await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true });
  }
  const repo = join(home, 'repository'); await cp(seed, repo, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
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
      encoding: 'utf8', input: JSON.stringify(args),
      // A rebase verifies and retains output, runs fresh checks and reattaches
      // the lease. Windows has taken 44 seconds at this real-process boundary.
      timeout: operation === 'attempt.rebase' && !('dryRun' in args && args.dryRun) ? 60000 : 20000,
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

test('R29/R04/R27: unknown profiles refuse definitions, automatic dispatch reports skips and status explains the repair', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'removed', definition: { ...definition, profile: 'worker' }, objectiveId: null }).status, 0);
  assert.equal(f.invoke('task.add', { id: 'next', definition, objectiveId: null }).status, 0);
  const before = await snapshot(f.home);
  for (const [operation, args] of [
    ['task.add', { id: 'invalid', definition: { ...definition, profile: 'absent' }, objectiveId: null }],
    ['task.update', { taskId: 'next', expectedRevision: 1, definition: { ...definition, title: 'Changed', profile: 'absent' } }],
  ] as const) {
    const refused = f.invoke(operation, args);
    assert.equal(refused.envelope.code, 'invalid_input');
    assert.equal(refused.data.field, 'profile');
    assert.deepEqual(refused.data.configuredNames, ['worker']);
    assert.deepEqual(await snapshot(f.home), before);
  }
  // Simulate a quiescent configuration change removing the task's chosen profile.
  const changed = { ...f.config, profiles: { replacement: f.config.profiles.worker }, defaultProfile: 'replacement',
    profileByKind: { code: 'replacement', report: 'replacement', review: 'replacement' } };
  await writeFile(f.file, JSON.stringify(changed));
  const parsed = await parseConfiguration(JSON.stringify(changed));
  using seed = new DatabaseSync(f.config.databasePath);
  const row = seed.prepare("SELECT payload FROM events WHERE kind = 'context.configured'").get()!;
  seed.prepare("UPDATE events SET payload = ? WHERE kind = 'context.configured'").run(JSON.stringify({ ...JSON.parse(String(row.payload)), ...parsed }));
  const stable = await snapshot(f.home);
  const named = f.invoke('attempt.dispatch', { taskId: 'removed', profile: null, dryRun: false });
  assert.equal(named.envelope.code, 'invalid_input');
  const plan = f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: true });
  assert.equal(plan.status, 0, JSON.stringify(plan.envelope));
  assert.equal(plan.data.taskId, 'next');
  assert.equal(plan.data.skippedTasks[0].taskId, 'removed');
  assert.match(plan.data.skippedTasks[0].reason, /worker.*not configured/);
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  const task = status.data.tasks.items.find((item: { id: string }) => item.id === 'removed');
  assert.equal(task.reason, plan.data.skippedTasks[0].reason);
  assert.match(task.nextAction.description, /Add the profile to the configuration, or change the task's profile/);
  assert.deepEqual(await snapshot(f.home), stable);
  const dispatched = f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: false }, 'automatic');
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  assert.equal(dispatched.data.attempt.taskId, 'next');
  assert.deepEqual(dispatched.data.skippedTasks, plan.data.skippedTasks);
  assert.deepEqual(f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: false }, 'automatic').data.skippedTasks, plan.data.skippedTasks);
});

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
  const detail = f.invoke('attempt.show', { attemptId: attempt.id }).data;
  assert.equal(detail.specification.task.instructions, definition.instructions, 'R27: attempt.show retains full instructions');
  for (const attentionOnly of [false, true]) {
    const status = f.invoke('status.show', { attentionOnly, page: { after: null, limit: 100 } }).data;
    assert.equal(JSON.stringify(status).includes(definition.instructions), false, 'R27: status excludes task instructions');
    assert.equal(JSON.stringify(status).includes('specification'), false);
    assert.equal(status.attempts.items[0].candidateCommit, attempt.candidate.commit);
    assert.equal(status.attempts.items[0].checksState, 'passed');
    assert.match(status.attempts.items[0].reason, /awaiting acceptance/u);
    assert.equal(status.attempts.items[0].nextAction.operation, 'attempt.accept');
    for (const item of [...status.tasks.items, ...status.attempts.items]) {
      assert.ok(item.reason); assert.ok(item.nextAction.description);
    }
    const schema = findOperation('status.show')!.outputSchema;
    const extra = structuredClone(status); extra.attempts.items[0].specification = {};
    assert.notEqual(validateSchema(schema, extra), null, 'A52: catalogue refuses full attempt detail in status');
    const missing = structuredClone(status); delete missing.tasks.items[0].ready;
    assert.notEqual(validateSchema(schema, missing), null, 'A52: catalogue requires compact task fields');
  }
  const acceptArgs = { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: true };
  const bytes = await snapshot(f.home);
  const acceptancePlan = f.invoke('attempt.accept', acceptArgs);
  assert.equal(acceptancePlan.status, 0, JSON.stringify(acceptancePlan.envelope));
  assert.deepEqual(await snapshot(f.home), bytes);
  const accepted = f.invoke('attempt.accept', { ...acceptArgs, dryRun: false }, 'accept');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.deepEqual(accepted.data.steps, acceptancePlan.data.steps);
  assert.equal(f.git('rev-parse', 'main'), attempt.candidate.commit);
  assert.equal(accepted.data.leaseReturn.state, 'returned', 'A21: local-merge automatically returns a safe lease');
  assert.equal(accepted.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items.length, 0);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, dryRun: false }, 'return');
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
  assert.equal(f.invoke('task.show', { taskId: 'feature' }).data.task.state, 'done');
  const records = (await readFile(join(f.home, 'peer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.type === 'prompt').length, 1);
});

test('R11: held and failed dispatches automatically return clean leases with retained output', async t => {
  for (const outcome of ['held', 'failed']) {
    const f = await fixture(t, `${outcome}-result`);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    const result = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
    assert.equal(result.status, 0, JSON.stringify(result.envelope));
    assert.equal(result.data.attempt.outcome, outcome);
    assert.equal(result.data.attempt.leaseState, 'returned');
    assert.equal(result.data.leaseReturn.state, 'returned');
    const replay = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
    assert.equal(replay.data.leaseReturn.state, 'returned');
    const detail = f.invoke('attempt.show', { attemptId: result.data.attempt.id }).data;
    assert.equal(f.git('rev-parse', result.data.attempt.specification.outputRef), detail.result.content.workReferences[0].commit);
  }
});

test('A21: kept leases show current dirt, retention and unresolved-effect reasons with next actions', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  const attempt = dispatched.data.attempt;
  await writeFile(join(attempt.allocation.path, 'untracked'), 'Keep this work');
  const accepted = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false });
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.equal(accepted.data.leaseReturn.state, 'kept');
  assert.equal(accepted.data.attempt.leaseState, 'held');
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  const attention = status.data.attempts.items.find((item: any) => item.id === attempt.id);
  assert.match(attention.reason, /uncommitted or untracked/);
  assert.equal(attention.nextAction.operation, 'attempt.return');
  assert.ok(attention.nextAction.description);

  // A later status read checks current retention, not just the failed automatic return.
  f.git('update-ref', attempt.specification.outputRef, attempt.specification.startingCommit);
  const unretained = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items[0];
  assert.match(unretained.reason, /retained/);
  assert.ok(unretained.nextAction.description);
  f.git('update-ref', attempt.specification.outputRef, attempt.candidate.commit);

  const db = await Database.open(f.config.databasePath, { readOnly: false,
    location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } });
  try {
    const caller = { kind: 'person' as const, id: String(userInfo().uid) };
    const [claim] = await db.registerClaims([{ resourceKey: 'uncertain-return-condition', role: 'maintenance', generation: 'condition',
      ownerRef: caller, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1, heartbeatAt: new Date().toISOString() }], caller);
    const command = await db.recordCommand({ requestKey: 'effect-condition', operation: 'test', caller, fingerprint: 'condition', input: {} });
    const executor = { claimId: claim!.id, generation: claim!.generation };
    const effect = await db.recordEffect({ requestKey: 'unresolved-condition', operation: 'workspace.test', caller, fingerprint: 'condition',
      input: {}, parentId: command.id, executor, attemptId: attempt.id, target: { kind: 'workspace', reference: attempt.allocation } });
    await db.claimEffect(effect.id, executor);
    await db.recordEffectOutcome(effect.id, executor, 'uncertain', { reason: 'Lost owner response' });
  } finally { db.close(); }
  const unresolved = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.attempts.items[0];
  assert.match(unresolved.reason, /unresolved effect/);
  assert.ok(unresolved.nextAction.description);
});

test('R28/A52: return and discard reject the removed noProcesses field', async t => {
  const f = await fixture(t);
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const [operation, args] of [
    ['attempt.return', { attemptId, dryRun: false }],
    ['attempt.discard', { attemptId, dryRun: false, confirmDiscard: true, reason: 'Not needed' }],
  ] as const) {
    assert.equal(validateSchema(findOperation(operation)!.inputSchema, args), null);
    assert.notEqual(validateSchema(findOperation(operation)!.inputSchema, { ...args, noProcesses: true }), null);
    assert.equal(f.invoke(operation, { ...args, noProcesses: true }).envelope.code, 'invalid_input');
  }
});

test('R27/R30: moved targets name exact commits and rebase action; target restrictions remain policy_refused', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
  const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
  const attempt = dispatched.data.attempt;
  f.git('commit', '--allow-empty', '-qm', 'Target moved independently');
  const targetCommit = f.git('rev-parse', 'main');
  for (const dryRun of [true, false]) {
    const before = await snapshot(f.home);
    const refused = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun });
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope.code, 'not_fast_forward');
    assert.deepEqual(refused.data, { attemptId: attempt.id, targetRef: 'refs/heads/main', targetCommit, candidateCommit: attempt.candidate.commit });
    assert.equal(refused.envelope.nextAction.operation, 'attempt.rebase');
    assert.deepEqual(refused.envelope.nextAction.args, { attemptId: attempt.id, dryRun: true });
    assert.ok(refused.envelope.nextAction.description);
    assert.deepEqual(await snapshot(f.home), before, 'Refusal preserves work and records');
  }
  for (const restrictions of [{ forbid: [], protectedTargets: ['main'] }, { forbid: ['local-merge'], protectedTargets: [] }]) {
    await writeFile(join(f.home, '.config', 'docket', 'finalisation.json'), JSON.stringify({ version: 1, ...restrictions }));
    // Planning/execution combinations run with fake owners in the operation
    // tests; keep real CLI policy loading and refusal for each restriction here.
    const refused = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false });
    assert.equal(refused.status, 1);
    assert.equal(refused.envelope.code, 'policy_refused');
    assert.equal(refused.envelope.nextAction, null);
  }
  assert.equal(f.git('rev-parse', attempt.specification.outputRef), attempt.candidate.commit);
  assert.equal(f.git('rev-parse', 'main'), targetCommit);
  await writeFile(join(f.home, '.config', 'docket', 'finalisation.json'), JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  const beforeRebase = await snapshot(f.home);
  const rebasePlan = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: true });
  assert.equal(rebasePlan.status, 0, JSON.stringify(rebasePlan.envelope));
  assert.deepEqual(await snapshot(f.home), beforeRebase);
  const rebased = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'rebase');
  assert.equal(rebased.status, 0, JSON.stringify(rebased.envelope) + rebased.stderr);
  assert.deepEqual(rebased.data.steps, rebasePlan.data.steps);
  assert.notEqual(rebased.data.attempt.candidate.id, attempt.candidate.id);
  const commit = rebased.data.attempt.candidate.commit;
  assert.equal(f.git('rev-parse', attempt.specification.outputRef), commit);
  assert.equal(f.git('rev-parse', `refs/docket/original/${attempt.specification.databaseId}/${attempt.id}`), attempt.candidate.commit);
  assert.equal(f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'rebase').data.attempt.candidate.commit, commit);
  const accepted = f.invoke('attempt.accept', { attemptId: attempt.id, candidateCommit: null, overrideReason: null, dryRun: false }, 'accept-rebased');
  assert.equal(accepted.status, 0, JSON.stringify(accepted.envelope));
  assert.equal(f.git('rev-parse', 'main'), commit);
  const returned = f.invoke('attempt.return', { attemptId: attempt.id, dryRun: false }, 'return-rebased');
  assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
  assert.equal(returned.data.attempt.leaseState, 'returned');
});

for (const sameLines of [false, true]) {
  test(`R14: repeated rebase excludes conflicting target history${sameLines ? ' when later target changes touch the same lines' : ''}`, async t => {
    const f = await fixture(t);
    assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
    const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
    assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
    const attempt = dispatched.data.attempt;
    const original = attempt.candidate.commit;
    const targetChange = async (text: string) => {
      await writeFile(join(f.repo, 'README'), text + '\n');
      f.git('commit', '-qam', text);
    };
    // Replaying the first target patch onto the final target would conflict.
    await targetChange('Intermediate target');
    await targetChange('First target');
    const firstTarget = f.git('rev-parse', 'HEAD');
    const first = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'first-rebase');
    assert.equal(first.status, 0, JSON.stringify(first.envelope));
    if (sameLines) await targetChange('Second target');
    else f.git('commit', '--allow-empty', '-qm', 'Target advances');
    const secondTarget = f.git('rev-parse', 'HEAD');
    // Repeated-rebase planning is covered with fake owners in completion.test.ts;
    // this boundary proves that real Git replays only the candidate's changes.
    const second = f.invoke('attempt.rebase', { attemptId: attempt.id, dryRun: false }, 'second-rebase');
    assert.equal(second.status, 0, JSON.stringify(second.envelope));
    const commit = second.data.attempt.candidate.commit;
    assert.equal(f.git('rev-list', '--count', `${secondTarget}..${commit}`), '1');
    assert.equal(f.git('rev-parse', `${commit}^`), secondTarget);
    assert.equal(f.git('diff', `${original}^`, original), f.git('diff', secondTarget, commit));
    assert.equal(f.git('show', `${commit}:README`), sameLines ? 'Second target' : 'First target');
    using db = await Database.open(f.config.databasePath, { readOnly: true,
      location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } });
    const event = db.events().findLast(e => e.kind === 'output.rebased' && e.attemptId === attempt.id)!;
    assert.deepEqual([event.payload.original, event.payload.upstream, event.payload.target, event.payload.rebased],
      [first.data.attempt.candidate.commit, firstTarget, secondTarget, commit]);
  });
}

test('R27/A52: failed checks appear in compact attention status with a reason and next action', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.docket'));
  await writeFile(join(f.repo, '.docket', 'checks.json'), JSON.stringify({ version: 1, fast: [],
    full: [{ name: 'fails', command: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 5000 }] }));
  f.git('add', '.'); f.git('commit', '-qm', 'Add failing check');
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  assert.equal(status.status, 0, JSON.stringify(status.envelope));
  const attempt = status.data.attempts.items[0];
  assert.equal(attempt.checksState, 'failed');
  assert.equal(attempt.reason, 'Candidate checks failed.');
  assert.equal(attempt.nextAction.operation, 'attempt.show');
  assert.equal(status.data.tasks.items[0].holdReason, 'checks_failed');
  assert.equal(JSON.stringify(status.data).includes(definition.instructions), false);
  const done = f.invoke('task.done', { taskId: 'feature', note: 'Person judgement' });
  assert.equal(done.status, 0, JSON.stringify(done.envelope));
  assert.equal(done.data.task.holdReason, null);
  const after = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
  assert.deepEqual(after.tasks.items, []);
  assert.deepEqual(after.attempts.items, []);
});

for (const decision of ['done', 'discard', 'return']) {
  test(`R03/R27: ${decision} removes an unaccepted candidate from attention status`, async t => {
    const f = await fixture(t);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    const dispatched = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
    assert.equal(dispatched.status, 0, JSON.stringify(dispatched.envelope));
    const attemptId = dispatched.data.attempt.id;
    assert.equal(f.invoke('task.show', { taskId: 'feature' }).data.task.holdReason, 'awaiting_acceptance');
    if (decision === 'done') {
      const done = f.invoke('task.done', { taskId: 'feature', note: 'Person judgement' });
      assert.equal(done.status, 0, JSON.stringify(done.envelope));
      assert.equal(done.data.task.state, 'done');
      assert.equal(done.data.task.holdReason, null);
    }
    if (decision === 'discard' || decision === 'return') {
      const result = decision === 'discard'
        ? f.invoke('attempt.discard', { attemptId, confirmDiscard: true, reason: 'Not needed', dryRun: false })
        : f.invoke('attempt.return', { attemptId, dryRun: false });
      assert.equal(result.status, 0, JSON.stringify(result.envelope));
      assert.equal(result.data.attempt.leaseState, 'returned');
    }
    const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data;
    assert.equal(status.attempts.items[0].reason, null);
    assert.equal(status.attempts.items[0].nextAction, null);
    const attention = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
    assert.deepEqual(attention.attempts.items, []);
    if (decision === 'done') assert.deepEqual(attention.tasks.items, []);
  });
}

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
    const discard = { attemptId, confirmDiscard: true, reason: 'Result is unusable', dryRun: false };
    const dirty = join(before.allocation.path, 'untracked');
    await writeFile(dirty, 'Keep this work');
    const kept = f.invoke('attempt.discard', discard);
    assert.equal(kept.data.leaseReturn.state, 'kept');
    assert.match(kept.data.leaseReturn.reason, /uncommitted or untracked/);
    assert.equal(f.invoke('attempt.show', { attemptId }).data.outcome, 'failed');
    await rm(dirty);
    const returned = f.invoke('attempt.return', { attemptId, dryRun: false }, 'return-discarded');
    assert.equal(returned.status, 0, JSON.stringify(returned.envelope));
    assert.equal(returned.data.attempt.outcome, 'failed');
    assert.equal(returned.data.attempt.executionOpen, false);
    assert.equal(returned.data.attempt.leaseState, 'returned');
    assert.equal(f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data.capacity.used, 0);
  }
});

test('A61/R10/R11: a failed model turn settles immediately, releases its owner and returns a clean lease', async t => {
  const f = await fixture(t, 'model-error');
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const failed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch');
  assert.equal(failed.envelope.code, 'worker_failed');
  assert.equal(failed.data.failureKind, 'model_error');
  assert.equal(failed.data.profile, 'worker');
  assert.match(failed.data.message, /\[redacted\]/);
  assert.equal(failed.envelope.nextAction.operation, 'attempt.show');
  const attemptId = failed.data.attemptId;
  assert.ok(attemptId, JSON.stringify(failed.envelope));
  const shown = f.invoke('attempt.show', { attemptId }).data;
  assert.ok(shown.terminalEvidence.length > 0, JSON.stringify(shown.terminalEvidence));
  assert.equal(shown.outcome, 'failed');
  assert.equal(shown.executionOpen, false);
  assert.equal(shown.leaseState, 'returned');
  const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } }).data;
  assert.deepEqual(status.blockers, []);
  assert.equal(status.claims.length, 0);
  assert.equal(status.capacity.used, 0);
});

test('A61/R08: a lost launcher connection remains owner_unknown, not a failed model outcome', async t => {
  const f = await fixture(t, 'lost-connection');
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const failed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false });
  assert.equal(failed.envelope.code, 'owner_unknown');
  const attempt = f.invoke('attempt.show', { attemptId: failed.data.attemptId }).data;
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.executionOpen, true);
  assert.deepEqual(f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data.limitedProfiles, []);
});

test('A61: provider limits block reservation, automatic selection reports skips, and person clearing permits reuse', async t => {
  const f = await fixture(t, 'usage-limit');
  const changed = { ...f.config, profiles: { worker: f.config.profiles.worker, other: f.config.profiles.worker },
    limits: { ...f.config.limits, maxAttemptsPerTask: 1 } };
  await writeFile(f.file, JSON.stringify(changed));
  assert.equal(f.invoke('context.configure', { dryRun: false }).status, 0);
  f.invoke('task.add', { id: 'limited', definition, objectiveId: null });
  const failed = f.invoke('attempt.dispatch', { taskId: 'limited', profile: null, dryRun: false });
  assert.equal(failed.envelope.code, 'worker_failed');
  assert.equal(failed.data.failureKind, 'provider_limit');
  assert.equal(failed.data.message, 'Codex error: The usage limit has been reached');
  assert.equal(failed.data.leaseReturn.state, 'returned');
  f.invoke('task.add', { id: 'next', definition, objectiveId: null });
  f.invoke('task.add', { id: 'other', definition: { ...definition, profile: 'other' }, objectiveId: null });
  const stable = await snapshot(f.home);
  for (const profile of [null, 'worker']) {
    const refused = f.invoke('attempt.dispatch', { taskId: 'next', profile, dryRun: false });
    assert.equal(refused.envelope.code, 'provider_limited');
    assert.equal(refused.data.profile, 'worker');
    assert.deepEqual(refused.data.configuredProfiles, ['other']);
    assert.ok(refused.data.time);
  }
  assert.deepEqual(await snapshot(f.home), stable);
  const automatic = f.invoke('attempt.dispatch', { taskId: null, profile: null, dryRun: true });
  assert.equal(automatic.status, 0, JSON.stringify(automatic.envelope));
  assert.equal(automatic.data.taskId, 'other');
  assert.ok(automatic.data.skippedTasks.some((item: { taskId: string }) => item.taskId === 'next'));
  const other = f.invoke('attempt.dispatch', { taskId: 'other', profile: null, dryRun: false });
  assert.equal(other.envelope.code, 'worker_failed');
  assert.equal(other.data.profile, 'other');
  const status = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  assert.equal(status.data.limitedProfiles.length, 2);
  assert.equal(status.data.limitedProfiles[0].nextAction.operation, 'profile.clear');
  const beforeClear = await snapshot(f.home);
  assert.equal(f.invoke('profile.clear', { profile: 'worker', dryRun: true }).status, 0);
  assert.deepEqual(await snapshot(f.home), beforeClear);
  assert.equal(f.invoke('profile.clear', { profile: 'worker', dryRun: false }).status, 0);
  assert.equal(f.invoke('task.release', { taskId: 'limited' }).status, 0);
  const retry = f.invoke('attempt.dispatch', { taskId: 'limited', profile: null, dryRun: false });
  assert.equal(retry.envelope.code, 'worker_failed', JSON.stringify(retry.envelope));
  assert.notEqual(retry.data.attemptId, failed.data.attemptId);
});

test('A16/A49/R30: stale claim and uncertain effect block dispatch until scoped person resolutions; plans do not write', async t => {
  const f = await fixture(t);
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  const options = { readOnly: false, location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [f.config.workspace.poolRoot] } };
  using db = await Database.open(f.config.databasePath, options);
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
  const attention = f.invoke('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }).data;
  assert.equal(attention.claims.length, 1);
  assert.match(attention.claims[0].reason, /stale/u);
  assert.equal(attention.claims[0].nextAction.operation, 'claim.resolve');
  assert.equal(attention.effects.length, 1);
  assert.match(attention.effects[0].reason, /uncertain/u);
  assert.equal(attention.effects[0].nextAction.operation, 'request.show');
  for (const item of [...attention.tasks.items, ...attention.claims, ...attention.effects, ...attention.blockers]) {
    assert.ok(item.reason, 'R27: every attention item explains why');
    assert.ok(item.nextAction.description, 'R27: every attention item has a next action');
  }
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
