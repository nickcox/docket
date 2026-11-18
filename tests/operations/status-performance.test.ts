import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialiseContext, openContext } from '../../src/context.ts';
import { createBinding } from '../../src/binding.ts';
import { Database } from '../../src/storage/database.ts';
import type { Runtime } from '../../src/runtime.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { configuration } from '../fixtures/configuration.ts';

// Count decoded rows, including connections opened by the operation itself.
for (const withObjective of [false, true]) test(`R08/A16/A17: status.show and attempt.show ignore a large unrelated heartbeat history (objective: ${withObjective})`, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-status-performance-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json');
  const config = configuration(home);
  config.limits.maxAttempts = 5;
  await writeFile(file, JSON.stringify(config));
  const person = { kind: 'person' as const, id: 'operator' };
  await initialiseContext({ config: file }, { home, caller: person, recyclableRoots: [] });
  const { database: db } = await openContext({ config: file }, { home, readOnly: false });
  defer(t, () => db.close());
  if (withObjective) await db.addObjective({ id: 'goal', request: 'Build', criteria: ['Works'], scope: '', constraints: '',
    permissions: null, budget: null, deadline: null }, person);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    await db.addTask({ id: `task-${i}`, title: 'Task', kind: 'code', criteria: ['Works'] }, person);
    const reservation = await db.reserveAttempt({ requestKey: `reserve-${i}`, taskId: `task-${i}`, caller: person,
      startingCommit: 'a'.repeat(40), checks: parseCheckPolicy('a'.repeat(40), null, { executionProfile: 'test', fast: [], full: [] }),
      delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } });
    ids.push(reservation.attempt.id);
  }
  const sql = new DatabaseSync(config.databasePath);
  defer(t, () => sql.close());
  sql.prepare('UPDATE attempts SET allocation = ?, lease_id = ?, lease_state = ? WHERE id = ?')
    .run(JSON.stringify({ leaseId: 'held-lease', path: join(home, 'held-workspace') }), 'held-lease', 'held', ids[0]!);
  // A held lease without terminal evidence exercises return planning but cannot read an owner.
  const binding = createBinding(person, { config: file }, { home, runtime: async () => ({ completion: {} }) as Runtime });
  const prototype = Database.prototype as unknown as { decodeEvent(row: unknown): unknown };
  const original = prototype.decodeEvent;
  let decoded = 0;
  prototype.decodeEvent = function (row) { decoded++; return original.call(this, row); };
  defer(t, () => { prototype.decodeEvent = original; });
  const measure = async () => {
    decoded = 0;
    const start = performance.now();
    const status = await binding.execute('status.show', { attentionOnly: false, page: { after: null, limit: 100 } });
    const statusMs = performance.now() - start, statusRows = decoded;
    decoded = 0;
    const attempt = await binding.execute('attempt.show', { attemptId: ids[0] });
    return { status, attempt, statusMs, statusRows, attemptRows: decoded };
  };
  const small = await measure();
  assert.ok(small.statusRows < 100);
  assert.ok(small.attemptRows < 100);
  await db.appendEvents(Array.from({ length: 20000 }, (_, i) => ({ sourceKey: `heartbeat-${i}`, kind: 'claim.refreshed',
    payloadVersion: 1, attemptId: ids[i % ids.length]!, correlationId: ids[i % ids.length]!, actor: person,
    occurredAt: new Date(0).toISOString(), payload: { heartbeatAt: new Date(0).toISOString() }, notification: false })));
  const large = await measure();
  console.log(JSON.stringify({ statusMs: large.statusMs, statusRows: large.statusRows, attemptRows: large.attemptRows }));
  assert.deepEqual(large.status, small.status);
  assert.deepEqual(large.attempt, small.attempt);
  assert.equal(large.statusRows, small.statusRows);
  assert.equal(large.attemptRows, small.attemptRows);

  // R10/A17: a discarded attempt with a held lease still needs attention and a return plan.
  for (const [i, id] of ids.entries()) {
    const allocation = { leaseId: `lease-${i}`, path: join(home, `workspace-${i}`) };
    sql.prepare('UPDATE attempts SET allocation = ?, lease_id = ?, lease_state = ? WHERE id = ?')
      .run(JSON.stringify(allocation), allocation.leaseId, i % 2 === 0 ? 'returned' : 'held', id);
    if (i % 2 !== 0) await db.appendEvents([{ sourceKey: `return.authorised:${id}`, kind: 'return.authorised',
      payloadVersion: 1, attemptId: id, correlationId: id, actor: person, occurredAt: new Date(0).toISOString(),
      payload: { discard: true }, notification: false }]);
  }
  const discarded = await binding.execute('status.show', { attentionOnly: true, page: { after: null, limit: 100 } });
  for (const [i, id] of ids.entries()) {
    if (i % 2 === 0) continue;
    const attempt = (discarded.attempts as { items: any[] }).items.find(a => a.id === id);
    assert.equal(attempt.leaseState, 'held');
    assert.match(attempt.reason, /stopped terminal worker/);
    assert.equal(attempt.nextAction.operation, 'attempt.return');
  }
  const discardedLarge = await measure();
  assert.ok(discardedLarge.statusRows < 150, 'Discard return planning must ignore heartbeat history');
  sql.prepare("UPDATE attempts SET lease_state = 'returned'").run();
  const withoutRuntime = createBinding(person, { config: file }, { home, runtime: async () => {
    assert.fail('R10: resolved leases must not initialise return-planning services');
  } });
  await withoutRuntime.execute('status.show', { attentionOnly: false, page: { after: null, limit: 100 } });
});
