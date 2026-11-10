import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Database, applicationId, schemaVersion, StorageError } from '../../src/storage/database.ts';
import type { EventInput, InitialConfiguration } from '../../src/storage/database.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  // macOS's /var is a link; use the canonical temporary directory.
  const { realpath } = await import('node:fs/promises');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'context.sqlite');
  const options = { location: { retainedRoot: root, recyclableRoots: [] }, retryMs: 100 };
  const initial: InitialConfiguration = { contextId: 'example', repository: { root: '/repository', identity: 'example' },
    stateDirectory: root, createdBy: { kind: 'person', id: 'operator' },
    configuration: { revision: 1, resolved: { version: 1 }, digest: 'sha256:example', provenance: { source: 'test' } } };
  return { root, path, options, initial };
}

function event(sourceKey: string): EventInput {
  return { sourceKey, kind: 'note.recorded', payloadVersion: 1, correlationId: 'test',
    actor: { kind: 'person' }, occurredAt: '2026-11-08T00:00:00.000Z', payload: { text: sourceKey } };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof StorageError && error.code === code;
}

test('A01/R24: empty path creates the exact v1 schema, seven tables, no triggers and genesis/config events', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  using sql = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(sql.prepare('PRAGMA application_id').get()!.application_id, applicationId);
  assert.equal(sql.prepare('PRAGMA user_version').get()!.user_version, schemaVersion);
  assert.deepEqual(sql.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name),
    ['attempts', 'claims', 'dependencies', 'events', 'objectives', 'requests', 'tasks']);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'").get()!.n, 0);
  // Compare every table/index definition with the normative specification, not just counts.
  using expected = new DatabaseSync(':memory:');
  expected.exec(await readFile(new URL('../../docs/specification/schema.sql', import.meta.url), 'utf8'));
  const definitions = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
  assert.deepEqual(sql.prepare(definitions).all(), expected.prepare(definitions).all());
  assert.equal(await readFile(new URL('../../src/storage/schema.sql', import.meta.url), 'utf8'),
    await readFile(new URL('../../docs/specification/schema.sql', import.meta.url), 'utf8'));
  const events = db.events();
  assert.deepEqual(events.map(e => e.kind), ['database.initialised', 'context.configured']);
  assert.equal(events[0]!.sourceKey, 'database.initialised');
  assert.match(String(events[0]!.payload.databaseId), /^[0-9a-f-]{36}$/);
  assert.equal(events[0]!.payload.schemaFamily, applicationId);
  assert.equal(events[0]!.payload.contextId, f.initial.contextId);
  assert.deepEqual(events[0]!.payload.repository, f.initial.repository);
  assert.deepEqual(events[1]!.payload, f.initial.configuration);
  const before = db.events();
  await assert.rejects(Database.initialise(f.path, f.initial, f.options), errorCode('not_empty'));
  assert.deepEqual(db.events(), before);
});

test('A01/R24: an existing zero-length regular file can be deliberately initialised', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '');
  using db = await Database.initialise(f.path, f.initial, f.options);
  assert.equal(db.events().length, 2);
});

test('A02/R26: other/missing families and unsupported versions refuse before WAL and leave bytes unchanged', async t => {
  const f = await fixture(t);
  for (const [family, version, code] of [[123, 1, 'family'], [0, 1, 'family'], [applicationId, 2, 'version'], [applicationId, 0, 'version']] as const) {
    using seed = new DatabaseSync(f.path);
    seed.exec(`PRAGMA application_id = ${family}; PRAGMA user_version = ${version}; CREATE TABLE keep_me (value TEXT); INSERT INTO keep_me VALUES ('unchanged')`);
    seed.close();
    const before = await readFile(f.path);
    for (const readOnly of [true, false]) {
      await assert.rejects(Database.open(f.path, { ...f.options, readOnly }), error => {
        assert.ok(errorCode(code)(error));
        assert.match(String(error), new RegExp(`version ${version}`));
        assert.match(String(error), /version 1/);
        return true;
      });
      assert.deepEqual(await readFile(f.path), before);
      assert.deepEqual(await readdir(f.root), ['context.sqlite']);
    }
    await assert.rejects(Database.initialise(f.path, f.initial, f.options), errorCode('not_empty'));
    assert.deepEqual(await readFile(f.path), before);
    await rm(f.path);
  }
});

test('A02/R26: non-SQLite and nonempty unrecognised files are never replaced', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'this is not SQLite\n');
  const before = await readFile(f.path);
  await assert.rejects(Database.open(f.path, { ...f.options, readOnly: false }), /not a database/);
  await assert.rejects(Database.initialise(f.path, f.initial, f.options), errorCode('not_empty'));
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(await readdir(f.root), ['context.sqlite']);
});

test('A02/R26: read-only missing status creates neither a database nor probes', async t => {
  const f = await fixture(t);
  await assert.rejects(Database.open(f.path, f.options), errorCode('not_initialised'));
  assert.deepEqual(await readdir(f.root), []);
});

test('A02/R24: canonical retained regular files only; reject links, directories and recyclable roots', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  const alias = join(f.root, 'alias');
  await symlink(f.path, alias);
  await assert.rejects(Database.open(alias, f.options), errorCode('path'));
  await assert.rejects(Database.open(f.root, f.options), errorCode('path'));
  const hard = join(f.root, 'hard');
  await link(f.path, hard);
  await assert.rejects(Database.open(f.path, f.options), errorCode('path'));
  await rm(hard);
  const directoryAlias = join(f.root, 'directory-alias');
  await symlink(f.root, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(Database.open(join(directoryAlias, 'context.sqlite'), f.options), errorCode('path'));
  await assert.rejects(Database.open(f.path, { ...f.options, location: { retainedRoot: f.root, recyclableRoots: [f.root] } }), errorCode('path'));
  const other = join(f.root, 'other');
  await mkdir(other);
  await assert.rejects(Database.open(f.path, { ...f.options, location: { retainedRoot: other, recyclableRoots: [] } }), errorCode('path'));
});

test('R24/R25: connections use WAL, foreign keys, FULL, full fsync requests and zero busy timeout', async t => {
  const f = await fixture(t);
  using created = await Database.initialise(f.path, f.initial, f.options);
  const expected = { journalMode: 'wal', foreignKeys: 1, synchronous: 2, busyTimeout: 0, fullfsync: 1, checkpointFullfsync: 1 };
  assert.deepEqual(created.settings(), expected);
  using writable = await Database.open(f.path, { ...f.options, readOnly: false });
  assert.deepEqual(writable.settings(), expected);
  using readonly = await Database.open(f.path, f.options);
  assert.deepEqual(readonly.settings(), expected);
  await assert.rejects(readonly.appendEvents([event('not-written')]), errorCode('read_only'));
  assert.equal(created.events().length, 2);
});

test('R25/A09: insert-only event batches roll back completely on conflicts and foreign key failures', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  const original = event('original');
  const [first] = await db.appendEvents([original]);
  assert.deepEqual(await db.appendEvents([{ ...original, actor: { kind: 'person' } }]), [first]);
  await assert.rejects(db.appendEvents([event('rolled-back'), { ...original, payload: { text: 'changed' } }]), errorCode('conflict'));
  await assert.rejects(db.appendEvents([event('also-rolled-back'), { ...event('bad-reference'), taskId: 'absent' }]), errorCode('conflict'));
  assert.deepEqual(db.events().map(e => e.sourceKey), ['database.initialised', 'context.configured:1', 'original']);
  await db.appendEvents([event('after-failure')]);
  assert.equal(db.events().length, 4);
});

test('R25: logical duplicate evidence ignores JSON key order but refuses different logical content', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  const input = { ...event('ordered'), payload: { a: 1, b: { c: true, d: null } } };
  const first = await db.appendEvents([input]);
  assert.deepEqual(await db.appendEvents([{ ...input, payload: { b: { d: null, c: true }, a: 1 } }]), first);
  await assert.rejects(db.appendEvents([{ ...input, notification: false }]), errorCode('conflict'));
});

test('R24/R25: BEGIN IMMEDIATE waits asynchronously, retries after release, and is bounded under contention', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, { ...f.options, retryMs: 1000 });
  using bounded = await Database.open(f.path, { ...f.options, readOnly: false, retryMs: 80 });
  using locker = new DatabaseSync(f.path, { timeout: 0 });
  locker.exec('BEGIN IMMEDIATE');
  const pending = db.appendEvents([event('after-lock')]);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await nextTurn();
  assert.equal(settled, false, 'event loop runs while the writer awaits its lock');
  locker.exec('ROLLBACK');
  await pending;
  locker.exec('BEGIN IMMEDIATE');
  await assert.rejects(bounded.appendEvents([event('timed-out')]), errorCode('busy'));
  locker.exec('ROLLBACK');
  assert.equal(db.events().some(e => e.sourceKey === 'timed-out'), false);
  await db.appendEvents([event('after-timeout')]);
});

test('R25: the internal callback already holds an immediate write lock and refuses asynchronous returns', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  using contender = new DatabaseSync(f.path, { timeout: 0 });
  const internal = db as unknown as { write: <T>(change: () => T) => Promise<T> };
  await internal.write(() => {
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), /locked/);
  });
  await assert.rejects(internal.write(() => Promise.resolve('not synchronous')), /must be synchronous/);
  await assert.rejects(internal.write(() => ({ then: () => undefined })), /must be synchronous/);
  await db.appendEvents([event('after-bad-callback')]);
  contender.exec('BEGIN IMMEDIATE; ROLLBACK');
});

test('R25: malformed event input is refused without any evidence changes', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  for (const bad of [
    { ...event('invalid'), extra: true },
    { ...event('invalid'), id: 'caller-chosen-id' },
    { ...event('invalid'), notification: 'true' },
    { ...event('invalid'), payload: [] },
    { ...event('invalid'), payloadVersion: 0 },
    { ...event('invalid'), taskId: '' },
    { ...event('invalid'), occurredAt: 'invalid' },
    { ...event('invalid'), payload: { cost: Infinity } },
  ]) {
    await assert.rejects(db.appendEvents([bad as EventInput]), TypeError);
  }
  assert.equal(db.events().length, 2);
});

test('R24/R26: changing to WAL is retried asynchronously on writable open, never on read-only open', async t => {
  const f = await fixture(t);
  const created = await Database.initialise(f.path, f.initial, f.options);
  created.close();
  using blocker = new DatabaseSync(f.path, { timeout: 0 });
  blocker.exec('PRAGMA journal_mode = DELETE');
  const before = await readFile(f.path);
  await assert.rejects(Database.open(f.path, f.options), /not in WAL mode/);
  assert.deepEqual(await readFile(f.path), before);
  blocker.exec('BEGIN IMMEDIATE');
  const pending = Database.open(f.path, { ...f.options, readOnly: false });
  // Hold the lock through the entire bounded retry, then verify a fresh open can succeed.
  await assert.rejects(pending, errorCode('busy'));
  blocker.exec('ROLLBACK');
  using opened = await Database.open(f.path, { ...f.options, readOnly: false });
  assert.equal(opened.settings().journalMode, 'wal');
});

test('R26: every write rechecks the family/version after acquiring its lock', async t => {
  const f = await fixture(t);
  using db = await Database.initialise(f.path, f.initial, f.options);
  using other = new DatabaseSync(f.path);
  other.exec('PRAGMA user_version = 2');
  await assert.rejects(db.appendEvents([event('stale-writer')]), errorCode('version'));
  assert.equal(other.prepare('SELECT count(*) AS n FROM events').get()!.n, 2);
});
