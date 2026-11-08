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

function message(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function cleanup() { child.off('message', received); child.off('exit', exited); child.off('error', failed); }
    function received(value: unknown) {
      cleanup();
      if (value === expected) resolve();
      else reject(new Error(`Unexpected child message: ${String(value)}`));
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) { cleanup(); reject(new Error(`Child exited before barrier: ${code}/${signal}`)); }
    function failed(error: Error) { cleanup(); reject(error); }
    child.on('message', received); child.on('exit', exited); child.on('error', failed);
  });
}

test('A09/R25: killing a process mid-reservation rolls back every change and releases its SQLite lock', { timeout: 8000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-crash-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, retryMs: 50 };
  using db = await Database.initialise(path, { contextId: 'crash', repository: { root: '/repo' }, stateDirectory: root,
    createdBy: { kind: 'person' }, configuration: { revision: 1, resolved: {}, digest: 'digest', provenance: {} } }, options);
  using sql = new DatabaseSync(path);
  sql.exec(`BEGIN IMMEDIATE;
    INSERT INTO tasks (id, title, instructions, criteria, kind, position) VALUES ('task', 'Task', '', '[]', 'code', 1);
    COMMIT;`);
  const writer = fork(new URL('./fixtures/storage-writer.ts', import.meta.url), [path, 'hold'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(writer);
  await message(writer, 'holding-write');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM attempts').get()!.n, 0, 'WAL reader cannot see an uncommitted reservation');
  await assert.rejects(db.appendEvents([{ sourceKey: 'blocked', kind: 'note.recorded', payloadVersion: 1,
    correlationId: 'crash-test', actor: {}, occurredAt: new Date().toISOString(), payload: {} }]), /remained busy/);
  const dead = once(writer, 'exit');
  writer.kill('SIGKILL');
  await dead;
  const recovery = fork(new URL('./fixtures/storage-writer.ts', import.meta.url), [path, 'commit'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(recovery);
  const recovered = once(recovery, 'exit');
  await message(recovery, 'committed');
  assert.equal((await recovered)[0], 0, 'a separate process can reopen and commit without stale locks');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM requests').get()!.n, 0);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM attempts').get()!.n, 0);
  assert.equal(sql.prepare("SELECT state FROM tasks WHERE id = 'task'").get()!.state, 'queued');
  assert.equal(sql.prepare("SELECT count(*) AS n FROM events WHERE source_key IN ('partial-event', 'blocked')").get()!.n, 0);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM events WHERE source_key = 'after-crash'").get()!.n, 1);
  assert.equal(sql.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});
