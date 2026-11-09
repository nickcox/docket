import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from '../../src/storage/database.ts';
import { unlimitedBudget } from '../../src/storage/objectives.ts';
import type { Budget } from '../../src/storage/objectives.ts';
import type { UsageReport } from '../../src/usage.ts';
import { budgetReason } from '../../src/usage.ts';
import { defer } from '../helpers/cleanup.ts';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';

const creator = { kind: 'person' as const, id: 'creator' };
const host = { kind: 'host', id: 'host' };
const hash = 'a'.repeat(40);
const stamp = '2026-01-01T00:00:00Z';
async function fixture(t: test.TestContext, budget: Budget = unlimitedBudget, deadline: string | null = null) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-usage-'));
  defer(t, () => rm(root, { force: true, recursive: true }));
  const profile = { launcher: 'pi', provider: 'test', model: 'test', reasoning: null, runMs: 1000, maxCost: null, maxTokens: null, executionProfile: 'test' };
  const db = await Database.initialise(join(root, 'db.sqlite'), { contextId: 'usage', repository: { identity: 'test' }, stateDirectory: root,
    createdBy: creator, configuration: { revision: 1, digest: 'test', provenance: {}, resolved: {
      version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
      limits: { maxAttempts: 10, maxAttemptsPerTask: 3, maxConcurrentFullChecks: 1 }, profiles: { worker: profile }, defaultProfile: 'worker',
      profileByKind: { code: 'worker', report: 'worker', review: 'worker' }, finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] },
    } } }, { location: { retainedRoot: root, recyclableRoots: [] } });
  defer(t, () => db.close());
  const objective = await db.addObjective({ id: 'goal', request: 'Work', criteria: [], scope: '', constraints: '', permissions: null, budget, deadline }, creator);
  await db.addTask({ id: 'task', title: 'Work', objectiveId: 'goal' }, creator);
  const reserve = (dryRun = false, usageMetrics = ['cost', 'tokens', 'workerTimeMs']) => db.reserveAttempt({ requestKey: 'reserve', caller: creator, taskId: 'task', startingCommit: hash,
    usageMetrics, checks: { sourceCommit: hash, digest: 'test', fast: [], full: [] },
    delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } }, dryRun);
  const register = (sessionId: string, kind: 'worker' | 'supervisor' = 'worker') => db.registerSession({ sessionId, kind, objectiveId: 'goal', attemptId: null,
    registeredAt: stamp, capabilities: ['cost', 'tokens', 'workerTimeMs'] }, host);
  const finish = (sessionId: string) => db.appendEvents([{ sourceKey: `finished:${sessionId}`, kind: 'session.finished', payloadVersion: 1,
    correlationId: sessionId, actor: host, occurredAt: stamp, objectiveId: 'goal', payload: { sessionId } }]);
  return { db, objective, reserve, register, finish };
}
function report(sessionId: string, sourceSequence: number, value: number | null, currency = 'USD'): UsageReport {
  return { sessionId, sourceSequence, observedAt: stamp,
    cost: { availability: value === null ? 'unknown' : 'reported', value, currency: value === null ? null : currency },
    tokens: { availability: value === null ? 'unknown' : 'reported', input: value, output: value, total: value },
    workerTimeMs: { availability: value === null ? 'unknown' : 'reported', value } };
}

test('R20/A40: concurrent session high-water values count once, zero is observed, unknown is not zero and currencies never convert', async t => {
  const { db, register, finish } = await fixture(t, { ...unlimitedBudget, currency: 'USD' });
  await register('worker'); await register('supervisor', 'supervisor'); await register('zero'); await register('unknown');
  const first = report('worker', 2, 10);
  await db.recordUsage(first, host); await db.recordUsage(first, host);
  await db.recordUsage(report('worker', 1, 4), host); await db.recordUsage(report('worker', 3, 2), host);
  await db.recordUsage(report('worker', 4, null), host);
  await db.recordUsage({ ...report('supervisor', 1, 20), workerTimeMs: { availability: 'unsupported', value: null } }, host);
  await db.recordUsage(report('zero', 1, 0), host);
  for (const session of ['worker', 'supervisor', 'zero', 'unknown']) await finish(session);
  const usage = db.objectiveUsage('goal');
  assert.deepEqual(usage.totals, { cost: 30, tokens: 30, workerTimeMs: 10 });
  assert.equal(usage.observations.find(o => o.sessionId === 'zero')!.cost.value, 0);
  assert.equal(usage.observations.find(o => o.sessionId === 'unknown')!.cost.value, null);
  assert.equal(usage.observations.find(o => o.sessionId === 'worker')!.tokens.input, 10);
  assert.deepEqual(usage.gaps.map(g => g.sessionId), ['worker', 'unknown']);
  assert.ok(usage.gaps[0]!.metrics.includes('tokens'), 'a later unavailable report preserves the high-water value and the gap');
  await db.recordUsage(report('worker', 5, 100, 'AUD'), host);
  assert.equal(db.objectiveUsage('goal').totals.cost, 30);
  assert.ok(db.objectiveUsage('goal').gaps.some(g => g.sessionId === 'worker' && g.metrics.includes('cost')));
  await assert.rejects(db.recordUsage({ ...first, cost: { ...first.cost, value: 50 } }, host));
  await assert.rejects(db.recordUsage(report('unregistered', 1, 0), host));
});

test('R20/A42: finished bounded gaps block until exact creator confirmation or observation; new session gaps still block', async t => {
  const { db, reserve, register, finish } = await fixture(t, { ...unlimitedBudget, maxTokens: 100 });
  await register('first'); await db.recordUsage(report('first', 1, null), host); await finish('first');
  for (const dryRun of [true, false]) await assert.rejects(reserve(dryRun), { data: { objectiveId: 'goal', budgetReason: 'unknown:tokens' } });
  const gaps = [{ sessionId: 'first', metrics: ['tokens' as const] }];
  for (const actor of [{ kind: 'person' as const, id: 'other' }, { kind: 'supervisor' as const, id: 'supervisor', objectiveId: 'goal', sessionId: 's' }]) {
    await assert.rejects(db.confirmUsage('goal', gaps, 'Accept uncertainty', actor), { code: 'creator_required' });
  }
  await assert.rejects(db.confirmUsage('goal', [{ sessionId: 'invented', metrics: ['tokens'] }], 'Wrong session', creator));
  await db.confirmUsage('goal', gaps, 'Accept exact token gap', creator);
  assert.equal((await reserve(true)).attempt.taskId, 'task');
  assert.equal(db.objectiveUsage('goal').totals.tokens, null);
  await register('next'); await finish('next');
  await assert.rejects(reserve(true), { data: { objectiveId: 'goal', budgetReason: 'unknown:tokens' } });
  await db.recordUsage(report('next', 1, 0), host);
  assert.equal((await reserve(true)).attempt.taskId, 'task');
  assert.ok(db.objectiveUsage('goal').gaps.some(g => g.metrics.includes('cost')), 'unbounded gaps remain visible');
});

for (const [metric, limit] of [['cost', 'maxCost'], ['tokens', 'maxTokens'], ['workerTimeMs', 'maxWorkerTimeMs']] as const) {
  test(`R20/A41: ${metric} refuses at zero, equality and above, and finite unsupported preflight refuses without writes`, async t => {
    const { db, reserve, register, finish } = await fixture(t, { ...unlimitedBudget, currency: 'USD', [limit]: 10 });
    await register('finished'); await db.recordUsage(report('finished', 1, 10), host); await finish('finished');
    const before = db.events();
    for (const dryRun of [true, false]) await assert.rejects(reserve(dryRun), { data: { objectiveId: 'goal', budgetReason: `limit:${metric}` } });
    assert.deepEqual(db.events(), before);
    assert.throws(() => db.checkBudget('goal', []), { data: { objectiveId: 'goal', budgetReason: `unsupported:${metric}` } });
    await db.recordUsage(report('finished', 2, 11), host);
    assert.throws(() => db.checkBudget('goal'), { data: { objectiveId: 'goal', budgetReason: `limit:${metric}` } });
    const current = db.objective('goal', creator);
    await db.updateObjective('goal', current.revision, { ...current, budget: { ...current.budget, [limit]: 0 } }, creator);
    assert.throws(() => db.checkBudget('goal'), { data: { objectiveId: 'goal', budgetReason: `limit:${metric}` } });
  });
}

test('R20/A41: running time and deadline checks work without usage reads; admission differs from running equality', async t => {
  const { db, objective, register } = await fixture(t, { ...unlimitedBudget, maxWorkerTimeMs: 100 });
  await register('running');
  const now = Date.parse(stamp);
  assert.equal(budgetReason(objective, db.events(), undefined, now + 100, true), null);
  assert.equal(budgetReason(objective, db.events(), undefined, now + 101, true), 'limit:workerTimeMs');
  assert.equal(budgetReason(objective, db.events(), undefined, now + 100), 'limit:workerTimeMs');
  const deadline = { ...objective, budget: unlimitedBudget, deadline: stamp };
  assert.equal(budgetReason(deadline, [], undefined, now, true), null);
  assert.equal(budgetReason(deadline, [], undefined, now + 1, true), 'deadline');
  await db.updateObjective('goal', objective.revision, deadline, creator);
  await assert.rejects(db.reserveAttempt({ requestKey: 'late', caller: creator, taskId: 'task', startingCommit: hash,
    checks: { sourceCommit: hash, digest: 'test', fast: [], full: [] },
    delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } }),
  { data: { objectiveId: 'goal', budgetReason: 'deadline' } });
});

test('R28/R30: usage operations have exact non-planable schemas and host-only reporting', () => {
  const usage = findOperation('host.usage')!, confirmation = findOperation('objective.confirm-usage')!;
  assert.deepEqual(usage.roles, ['host']); assert.equal(usage.plans, false);
  assert.deepEqual(confirmation.roles, ['person']); assert.equal(confirmation.plans, false);
  assert.equal(validateSchema(usage.inputSchema, { report: report('session', 1, 0) }), null);
  assert.ok(validateSchema(usage.inputSchema, { report: { ...report('session', 1, 0), caller: creator } }));
  assert.ok(validateSchema(confirmation.inputSchema, { objectiveId: 'goal', sessionGaps: [{ sessionId: 's', metrics: ['invented'] }], reason: 'No' }));
});
