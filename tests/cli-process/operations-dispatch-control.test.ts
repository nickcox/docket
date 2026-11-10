import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { definition, fixture, snapshot, entry } from '../helpers/cli-operations.ts';

test('R07/R08/R09/R31/R35: a separate CLI stops the live dispatch owner; Pi steering refuses without delivery', { timeout: 120000 }, async t => {
  const f = await fixture(t, 'running');
  assert.equal(f.invoke('task.add', { id: 'feature', definition, objectiveId: null }).status, 0);
  const child = spawn(process.execPath, [entry, 'attempt', 'dispatch', '--config', f.file, '--stdin', '--json', '--request-id', 'live-dispatch'], {
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, PEER_MODE: 'running', PEER_RECORD: join(f.home, 'peer.jsonl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify({ taskId: 'feature', profile: null, dryRun: false }));
  // Reaching worker.wait takes several process starts, which are slow on Windows runners.
  const until = Date.now() + 60000;
  while (!stderr.includes('worker.wait') && Date.now() < until && child.exitCode === null) await delay(20);
  assert.ok(stderr.includes('worker.wait'), stderr + stdout);
  const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } });
  const attemptId = status.data.attempts.items[0].id;
  // The live owner polls usage independently of these read-only/refused controls.
  const controlSnapshot = async () => Object.fromEntries(Object.entries(await snapshot(f.home)).filter(([path]) => path !== join(f.home, 'peer.jsonl')));
  const before = await controlSnapshot();
  for (const mode of ['active', 'after_turn']) for (const dryRun of [true, false]) {
    const steer = f.invoke('attempt.steer', { attemptId, message: 'Change direction', mode, dryRun });
    assert.equal(steer.envelope.code, 'capability_missing');
  }
  assert.deepEqual(await controlSnapshot(), before);
  const planned = f.invoke('attempt.stop', { attemptId, dryRun: true });
  assert.equal(planned.status, 0);
  assert.deepEqual(await controlSnapshot(), before);
  const stopped = f.invoke('attempt.stop', { attemptId, dryRun: false }, 'stop');
  assert.equal(stopped.status, 0, JSON.stringify(stopped.envelope));
  assert.deepEqual(stopped.data.steps, planned.data.steps);
  const [code] = await exited;
  assert.equal(code, 0, stderr + stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.data.attempt.outcome, 'interrupted');
  assert.equal(result.data.attempt.executionOpen, false);
  assert.ok(f.invoke('attempt.show', { attemptId }).data.terminalEvidence);
  assert.equal(f.invoke('attempt.stop', { attemptId, dryRun: false }, 'stop').status, 0);
  const peer = (await readFile(join(f.home, 'peer.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(peer.filter(row => row.type === 'prompt').length, 1);
  assert.equal(peer.filter(row => ['steer', 'follow_up'].includes(row.type)).length, 0);
});

test('R11: held and failed dispatches automatically return clean leases with retained output', async t => {
  for (const outcome of ['held', 'failed']) {
    const f = await fixture(t, `${outcome}-result`);
    f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
    // Like review dispatch, automatic return adds retention and lease-safety
    // probes. Allow for their many Git/Treehouse process starts on Windows CI.
    const result = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch', undefined, 60000);
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

test('A61/R10/R11: a failed model turn settles immediately, releases its owner and returns a clean lease', async t => {
  const f = await fixture(t, 'model-error');
  f.invoke('task.add', { id: 'feature', definition, objectiveId: null });
  // Failure also returns the lease, with the same slow Windows safety probes.
  const failed = f.invoke('attempt.dispatch', { taskId: 'feature', profile: null, dryRun: false }, 'dispatch', undefined, 60000);
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
  // Each provider failure below returns a lease. Only those live dispatches
  // need headroom for Windows Git/Treehouse starts, not plans or refusals.
  const failed = f.invoke('attempt.dispatch', { taskId: 'limited', profile: null, dryRun: false }, undefined, undefined, 60000);
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
  const other = f.invoke('attempt.dispatch', { taskId: 'other', profile: null, dryRun: false }, undefined, undefined, 60000);
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
  const retry = f.invoke('attempt.dispatch', { taskId: 'limited', profile: null, dryRun: false }, undefined, undefined, 60000);
  assert.equal(retry.envelope.code, 'worker_failed', JSON.stringify(retry.envelope));
  assert.notEqual(retry.data.attemptId, failed.data.attemptId);
});
