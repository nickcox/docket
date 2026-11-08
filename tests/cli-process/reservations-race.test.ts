import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Database } from '../../src/storage/database.ts';
import type { ReservationInput } from '../../src/storage/reservations.ts';

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', received); child.off('error', failed); child.off('exit', exited); };
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => { cleanup(); reject(new Error('Reservation contender exited before its result')); };
    child.on('message', received); child.on('error', failed); child.on('exit', exited);
  });
}

for (const mode of ['automatic', 'named', 'replay'] as const) {
  test(`A06/A07/R04: independent processes serialise ${mode} reservation at capacity two`, { timeout: 8000 }, async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-reservation-race-'));
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    });
    const path = join(root, 'context.sqlite');
    const actor = { kind: 'person' as const, id: 'operator' };
    using db = await Database.initialise(path, { contextId: 'race', repository: {}, stateDirectory: root, createdBy: actor,
      configuration: { revision: 1, digest: 'config', provenance: {}, resolved: {
        version: 1, baseBranch: 'main', workspace: { adapter: 'treehouse', poolRoot: join(root, 'pool') },
        limits: { maxAttempts: 2, maxAttemptsPerTask: 3 },
        profiles: { worker: { launcher: 'bb', provider: 'provider', model: 'model', reasoning: null,
          runMs: 1000, maxCost: null, maxTokens: null, executionProfile: 'bb-worker-v1' } },
        defaultProfile: 'worker', profileByKind: { code: 'worker', report: 'worker', review: 'worker' },
        finalisation: { kind: 'manual', targetBranch: 'main', globalFile: null, forbid: [] },
      } } }, { location: { retainedRoot: root, recyclableRoots: [] } });
    for (const id of ['exhausted', 'first', 'second', 'third']) await db.addTask({ id, title: id }, actor);
    using seed = new DatabaseSync(path);
    for (let number = 1; number <= 3; number++) {
      seed.prepare(`INSERT INTO attempts (id, task_id, number, execution_open, phase, specification, output_ref, outcome, created_at)
        VALUES (?, 'exhausted', ?, 0, 'settled', '{}', ?, 'held', 'now')`).run(`old-${number}`, number, `old-ref-${number}`);
    }
    const ready: Promise<unknown>[] = [];
    for (let index = 0; index < 4; index++) {
      const input: ReservationInput = { requestKey: mode === 'replay' ? 'shared' : `request-${index}`, caller: actor,
        ...(mode === 'named' ? { taskId: 'first' } : {}), startingCommit: 'a'.repeat(40),
        checks: { sourceCommit: 'a'.repeat(40), digest: 'checks', fast: [], full: [] },
        delivery: { kind: 'code', acceptance: 'review_or_integration', requiredEvidence: [], requiredDeliverables: [] } };
      const child = fork(new URL('./fixtures/reservation-contender.ts', import.meta.url), [path, JSON.stringify(input)],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      ready.push(message(child));
    }
    assert.deepEqual(await Promise.all(ready), ['ready', 'ready', 'ready', 'ready']);
    const results = children.map(message), exits = children.map(child => once(child, 'exit'));
    for (const child of children) child.send('go');
    const outcomes = await Promise.all(results) as { result: string; id?: string; taskId?: string; replayed?: boolean }[];
    for (const exit of await Promise.all(exits)) assert.equal(exit[0], 0);
    const open = seed.prepare('SELECT id, task_id FROM attempts WHERE execution_open = 1 ORDER BY task_id').all();
    assert.equal(open.length, mode === 'automatic' ? 2 : 1);
    assert.equal(new Set(open.map(row => row.task_id)).size, open.length);
    assert.deepEqual(open.map(row => row.task_id), mode === 'automatic' ? ['first', 'second'] : ['first']);
    assert.equal(db.events().filter(event => event.kind === 'attempt.reserved').length, open.length);
    assert.equal(db.requests().length, open.length);
    if (mode === 'replay') {
      assert.ok(outcomes.every(outcome => outcome.result === 'reserved' && outcome.id === open[0]!.id));
      assert.equal(outcomes.filter(outcome => outcome.replayed === false).length, 1);
    } else {
      assert.equal(outcomes.filter(outcome => outcome.result === 'reserved').length, open.length);
      assert.equal(outcomes.filter(outcome => outcome.result === 'conflict').length, 4 - open.length);
    }
  });
}
