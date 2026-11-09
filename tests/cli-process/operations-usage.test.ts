import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { definition, fixture, entry } from '../helpers/cli-operations.ts';
import { defer } from '../helpers/cleanup.ts';

for (const limit of ['time', 'deadline']) test(`R20/A41: dispatch fences on ${limit} while the Pi usage read is pending`, { timeout: 120000 }, async t => {
  const f = await fixture(t, 'running-no-usage');
  const fields = { criteria: ['Works'], scope: '', constraints: '', permissions: {},
    budget: { maxCost: null, currency: 'USD', maxTokens: null, maxWorkerTimeMs: null }, deadline: null as string | null };
  assert.equal(f.invoke('objective.add', { id: 'goal', request: 'Work', ...fields }).status, 0);
  assert.equal(f.invoke('task.add', { id: 'task', definition, objectiveId: 'goal' }).status, 0);
  const child = spawn(process.execPath, [entry, 'attempt', 'dispatch', '--config', f.file, '--stdin', '--json'], {
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, PEER_MODE: 'running-no-usage', PEER_RECORD: join(f.home, 'peer.jsonl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  defer(t, async () => { if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify({ taskId: 'task', profile: null, dryRun: false }));
  const until = Date.now() + 60000;
  while (!stderr.includes('worker.wait') && Date.now() < until && child.exitCode === null) await delay(20);
  assert.ok(stderr.includes('worker.wait'), stderr + stdout);
  const changed = limit === 'time' ? { ...fields, budget: { ...fields.budget, maxWorkerTimeMs: 0 } }
    : { ...fields, deadline: '2020-01-01T00:00:00Z' };
  const update = f.invoke('objective.update', { objectiveId: 'goal', expectedRevision: 1, ...changed });
  assert.equal(update.status, 0, JSON.stringify(update.envelope));
  // Fencing must not wait for the outstanding usage RPC's timeout.
  const stopUntil = Date.now() + 3000;
  while (!stderr.includes('worker.fence') && Date.now() < stopUntil) await delay(20);
  assert.ok(stderr.includes('worker.fence'), stderr + stdout);
  const [code] = await exited;
  assert.equal(code, 0, stderr + stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.data.attempt.outcome, 'over_budget');
  assert.equal(result.data.attempt.executionOpen, false);
  const objective = f.invoke('objective.show', { objectiveId: 'goal' }).data.objective;
  assert.ok(objective.usage.totals.workerTimeMs > 0);
  assert.equal(objective.usage.totals.tokens, null);
  assert.ok(objective.usage.gaps.some((g: { metrics: string[] }) => g.metrics.includes('tokens')));
  const status = f.invoke('status.show', { attentionOnly: false, page: { after: null, limit: 100 } });
  assert.deepEqual(status.data.objectives[0].usage, objective.usage);
});
