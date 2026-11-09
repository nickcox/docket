import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { defer } from '../helpers/cleanup.ts';

for (const failing of [false, true]) test(`R38: fixture cleanup closes every SQLite connection before removing its directory (failure=${failing})`, async () => {
  let cleanup: (() => Promise<void>) | undefined;
  const t = { after(fn: () => Promise<void>) { assert.equal(cleanup, undefined); cleanup = fn; } };
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-cleanup-'));
  const order: string[] = [];
  const first = new DatabaseSync(join(root, 'context.sqlite'));
  first.exec('PRAGMA journal_mode = WAL; CREATE TABLE example (id INTEGER)');
  const second = new DatabaseSync(join(root, 'context.sqlite'));
  defer(t, async () => {
    assert.equal(first.isOpen, false);
    assert.equal(second.isOpen, false);
    order.push('directory');
    await rm(root, { recursive: true, force: true });
  });
  defer(t, () => { first.close(); order.push('first'); });
  defer(t, () => { second.close(); order.push('second'); });
  defer(t, () => { order.push('last'); if (failing) throw new Error('Cleanup failed'); });
  if (failing) await assert.rejects(cleanup!, AggregateError);
  else await cleanup!();
  assert.deepEqual(order, ['last', 'second', 'first', 'directory']);
});
