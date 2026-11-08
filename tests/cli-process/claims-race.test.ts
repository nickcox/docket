import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from '../../src/storage/database.ts';

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', received); child.off('error', failed); child.off('exit', exited); };
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => { cleanup(); reject(new Error('Claim contender exited before the barrier')); };
    child.on('message', received); child.on('error', failed); child.on('exit', exited);
  });
}

test('R25: two independent processes racing for one resource commit exactly one claim and its event', { timeout: 8000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-claim-race-'));
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
  const options = { location: { retainedRoot: root, recyclableRoots: [] } };
  using db = await Database.initialise(path, { contextId: 'race', repository: {}, stateDirectory: root, createdBy: {},
    configuration: { revision: 1, resolved: {}, digest: 'test', provenance: {} } }, options);
  const ready: Promise<unknown>[] = [];
  for (const generation of ['first', 'second']) {
    const child = fork(new URL('./fixtures/claim-contender.ts', import.meta.url), [path, generation], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child);
    ready.push(message(child));
  }
  assert.deepEqual(await Promise.all(ready), ['ready', 'ready']);
  const results = children.map(message);
  const exits = children.map(child => once(child, 'exit'));
  for (const child of children) child.send('go');
  const outcomes = await Promise.all(results) as { result: string; claimId?: string }[];
  assert.deepEqual(outcomes.map(outcome => outcome.result).sort(), ['conflict', 'registered']);
  for (const exit of await Promise.all(exits)) assert.equal(exit[0], 0);
  const claims = db.claims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.id, outcomes.find(outcome => outcome.result === 'registered')!.claimId);
  assert.equal(claims[0]!.releasedAt, null);
  assert.equal(db.events().filter(event => event.kind === 'claim.registered').length, 1);
  using reopened = await Database.open(path, options);
  assert.deepEqual(reopened.claims(), claims);
});
