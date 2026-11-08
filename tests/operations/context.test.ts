import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigurationError, parseConfiguration } from '../../src/configuration.ts';
import { ContextError, initialiseContext, openContext, resolveContext } from '../../src/context.ts';
import { Database, StorageError } from '../../src/storage/database.ts';
import { configuration } from '../fixtures/configuration.ts';
import { findOperation } from '../../src/catalog.ts';
import { executeCoreOperation } from '../../src/operations.ts';

async function fixture(t: test.TestContext, contextId = 'example') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-context-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json');
  const config = configuration(home, contextId);
  await writeFile(file, JSON.stringify(config));
  return { home, file, config, options: { home, recyclableRoots: [] as string[], caller: { kind: 'person' as const, id: 'operator' } }, registry: join(home, '.config', 'docket', 'contexts.json') };
}

function contextError(code: ContextError['code']) { return (error: unknown) => error instanceof ContextError && error.code === code; }

test('A01/R39/R29: init creates default paths, a unique database identity and genesis configuration, then registers the file', async t => {
  const f = await fixture(t);
  const result = await initialiseContext({ config: f.file }, f.options);
  assert.equal(result.stateDirectory, join(f.home, '.docket', 'example'));
  assert.equal(result.databasePath, join(f.config.stateDirectory, 'docket.db'));
  assert.equal(result.poolRoot, join(f.config.stateDirectory, 'pool'));
  assert.match(String(result.databaseId), /^[a-f0-9-]{36}$/u);
  assert.ok((await lstat(f.config.workspace.poolRoot)).isDirectory());
  assert.deepEqual(JSON.parse(await readFile(f.registry, 'utf8')), { example: f.file });
  const context = await openContext({ context: 'example' }, f.options);
  using database = context.database;
  const events = database.events();
  assert.deepEqual(events.map(event => event.kind), ['database.initialised', 'context.configured']);
  assert.equal(context.databaseId, result.databaseId);
  assert.deepEqual(events[1]!.payload.resolved, f.config);
  assert.equal(events[1]!.payload.digest, (await parseConfiguration(JSON.stringify(f.config))).digest);
  assert.equal(events[1]!.payload.revision, 1);
  assert.deepEqual(events[1]!.payload.provenance, { file: f.file });
  assert.deepEqual((await resolveContext({ config: f.file }, f.options)), (await resolveContext({ context: 'example' }, f.options)));
  assert.deepEqual(await readdir(f.config.workspace.poolRoot), []);
  assert.deepEqual(database.tasks(), []);
  assert.deepEqual(database.claims(), []);
});

for (const suppliedCaller of [false, true]) {
  test(`A01/R39: context.init records ${suppliedCaller ? 'the supplied caller' : 'the OS person caller'} as the genesis creator`, async t => {
    const f = await fixture(t);
    const { caller, ...options } = f.options;
    const expected = suppliedCaller ? caller : { kind: 'person', id: String(userInfo().uid) };
    await executeCoreOperation(findOperation('context.init')!, {}, () => {}, { config: f.file }, undefined,
      suppliedCaller ? f.options : options);
    const context = await openContext({ config: f.file }, f.options);
    using database = context.database;
    const genesis = database.events().find(event => event.kind === 'database.initialised')!;
    assert.deepEqual(genesis.payload.createdBy, expected);
  });
}

test('A01/R39: explicit state/database/pool paths are honoured and existing registry entries are preserved', async t => {
  const f = await fixture(t, 'first');
  await initialiseContext({ config: f.file }, f.options);
  const second = configuration(f.home, 'second');
  second.stateDirectory = join(f.home, 'custom');
  second.databasePath = join(f.home, 'separate-database', 'custom.db');
  second.workspace.poolRoot = join(f.home, 'custom-pool');
  const file = join(f.home, 'second.json');
  await writeFile(file, JSON.stringify(second));
  const result = await initialiseContext({ config: file }, f.options);
  assert.equal(result.databasePath, second.databasePath);
  assert.ok((await lstat(second.workspace.poolRoot)).isDirectory());
  const opened = await openContext({ context: 'second' }, f.options);
  using secondDb = opened.database;
  assert.equal(opened.databaseId, result.databaseId);
  assert.equal(secondDb.events()[1]!.payload.digest, result.digest);
  assert.deepEqual(JSON.parse(await readFile(f.registry, 'utf8')), { first: f.file, second: file });
  const first = await openContext({ context: 'first' }, f.options);
  using firstDb = first.database;
  assert.notEqual(result.databaseId, first.databaseId);
});

test('A01/R39: an already registered name refuses without changing database, registry or pool', async t => {
  const f = await fixture(t);
  await initialiseContext({ config: f.file }, f.options);
  const database = await readFile(f.config.databasePath);
  const registry = await readFile(f.registry);
  await writeFile(join(f.config.workspace.poolRoot, 'retained'), 'must remain');
  await assert.rejects(initialiseContext({ config: f.file }, f.options), contextError('context_registered'));
  assert.deepEqual(await readFile(f.config.databasePath), database);
  assert.deepEqual(await readFile(f.registry), registry);
  assert.equal(await readFile(join(f.config.workspace.poolRoot, 'retained'), 'utf8'), 'must remain');
});

test('A01/R39: a nonempty database refuses without touching its bytes, registry or creating a pool', async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDirectory, { recursive: true });
  const bytes = Buffer.from('not an empty database');
  await writeFile(f.config.databasePath, bytes);
  await mkdir(join(f.home, '.config', 'docket'), { recursive: true });
  await writeFile(f.registry, '{}\n');
  await assert.rejects(initialiseContext({ config: f.file }, f.options), (error: unknown) => error instanceof StorageError && error.code === 'not_empty');
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  assert.equal(await readFile(f.registry, 'utf8'), '{}\n');
  await assert.rejects(lstat(f.config.workspace.poolRoot), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(f.home, '.config', 'docket')), ['contexts.json']);
});

test('A01/R39: a zero-length file is initialised, but an existing context database under a new name is never adopted', async t => {
  const f = await fixture(t);
  await mkdir(f.config.stateDirectory, { recursive: true });
  await writeFile(f.config.databasePath, '');
  await initialiseContext({ config: f.file }, f.options);
  await writeFile(f.registry, '{}');
  const bytes = await readFile(f.config.databasePath);
  await assert.rejects(initialiseContext({ config: f.file }, f.options), (error: unknown) => error instanceof StorageError && error.code === 'not_empty');
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  assert.equal(await readFile(f.registry, 'utf8'), '{}');
});

test('A53/R29: edited configuration refuses before later operations, reporting recorded/current digests and revisions', async t => {
  const f = await fixture(t);
  const result = await initialiseContext({ config: f.file }, f.options);
  const bytes = await readFile(f.config.databasePath);
  f.config.limits.maxAttempts = 2;
  await writeFile(f.file, JSON.stringify(f.config));
  const current = await parseConfiguration(JSON.stringify(f.config));
  for (const selector of [{ config: f.file }, { context: 'example' }] as const) {
    await assert.rejects(openContext(selector, { ...f.options, readOnly: false }), (error: unknown) => {
      assert.ok(error instanceof ContextError);
      assert.equal(error.code, 'config_changed');
      assert.deepEqual(error.data, { recordedDigest: result.digest, currentDigest: current.digest, recordedRevision: 1, currentRevision: 1 });
      return true;
    });
  }
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  f.config.limits.maxAttempts = 1;
  await writeFile(f.file, JSON.stringify(f.config));
  await assert.rejects(openContext({ config: f.file }, { ...f.options, expectedRevision: 2 }), (error: unknown) => error instanceof ContextError && error.code === 'config_changed' && error.data.currentRevision === 2 && error.data.recordedRevision === 1);
});

test('A53/R29: admission uses the latest configured event, not the genesis digest', async t => {
  const f = await fixture(t);
  await initialiseContext({ config: f.file }, f.options);
  using database = await Database.open(f.config.databasePath, { readOnly: false, location: { retainedRoot: f.config.stateDirectory, recyclableRoots: [] } });
  const previous = database.events()[1]!;
  await database.appendEvents([{ ...previous, sourceKey: 'context.configured:2', payload: { ...previous.payload, digest: 'different', revision: 2 } }].map(({ seq, id, recordedAt, ...event }) => event));
  await assert.rejects(openContext({ config: f.file }, f.options), (error: unknown) => error instanceof ContextError && error.code === 'config_changed' && error.data.recordedDigest === 'different' && error.data.recordedRevision === 2);
});

test('R01: state directory, database and pool each refuse inside a trusted recyclable root before any creation', async t => {
  for (const field of ['stateDirectory', 'databasePath', 'poolRoot']) {
    const f = await fixture(t);
    const root = field === 'stateDirectory' ? f.config.stateDirectory : field === 'databasePath' ? f.config.databasePath : f.config.workspace.poolRoot;
    await assert.rejects(initialiseContext({ config: f.file }, { ...f.options, recyclableRoots: [root] }), (error: unknown) => error instanceof ConfigurationError && error.field === (field === 'poolRoot' ? '$.workspace.poolRoot' : `$.${field}`));
    await assert.rejects(lstat(f.config.stateDirectory), { code: 'ENOENT' });
    await assert.rejects(lstat(f.registry), { code: 'ENOENT' });
  }
});

test('R01/R39: different context names cannot collide on state or pool paths', async t => {
  const f = await fixture(t);
  await initialiseContext({ config: f.file }, f.options);
  const before = await readFile(f.registry);
  const other = { ...f.config, contextId: 'other' };
  const file = join(f.home, 'other.json');
  await writeFile(file, JSON.stringify(other));
  await assert.rejects(initialiseContext({ config: file }, f.options), contextError('context_mismatch'));
  assert.deepEqual(await readFile(f.registry), before);
});

test('R01/R39: a separate database path cannot collide with another registered context', async t => {
  const f = await fixture(t);
  f.config.databasePath = join(f.home, 'databases', 'shared.db');
  await writeFile(f.file, JSON.stringify(f.config));
  await initialiseContext({ config: f.file }, f.options);
  const before = await readFile(f.registry);
  const bytes = await readFile(f.config.databasePath);
  const other = configuration(f.home, 'other');
  other.databasePath = f.config.databasePath;
  const file = join(f.home, 'other.json');
  await writeFile(file, JSON.stringify(other));
  await assert.rejects(initialiseContext({ config: file }, f.options), contextError('context_mismatch'));
  assert.deepEqual(await readFile(f.registry), before);
  assert.deepEqual(await readFile(f.config.databasePath), bytes);
  await assert.rejects(lstat(other.stateDirectory), { code: 'ENOENT' });
});

test('A53/R29: equivalent file formatting remains admitted without a new configuration event', async t => {
  const f = await fixture(t);
  const result = await initialiseContext({ config: f.file }, f.options);
  await writeFile(f.file, JSON.stringify(Object.fromEntries(Object.entries(f.config).reverse()), null, 4));
  const context = await openContext({ context: 'example' }, f.options);
  using database = context.database;
  assert.equal(context.configuration.digest, result.digest);
  assert.equal(database.events().length, 2);
});

test('R01/R39: an edited registered configuration cannot hide storage collisions during another init', async t => {
  const f = await fixture(t);
  await initialiseContext({ config: f.file }, f.options);
  f.config.workspace.poolRoot = join(f.home, 'moved-pool');
  await writeFile(f.file, JSON.stringify(f.config));
  const other = configuration(f.home, 'other');
  const file = join(f.home, 'other.json');
  await writeFile(file, JSON.stringify(other));
  const before = await readFile(f.registry);
  await assert.rejects(initialiseContext({ config: file }, f.options), contextError('config_changed'));
  assert.deepEqual(await readFile(f.registry), before);
  await assert.rejects(lstat(other.stateDirectory), { code: 'ENOENT' });
});

test('R39: a held registry lock refuses without changing it or creating context state', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.config', 'docket'), { recursive: true });
  const lock = await open(`${f.registry}.lock`, 'wx');
  await lock.close();
  await assert.rejects(initialiseContext({ config: f.file }, f.options), contextError('storage_busy'));
  await assert.rejects(lstat(f.config.stateDirectory), { code: 'ENOENT' });
  assert.ok((await lstat(`${f.registry}.lock`)).isFile());
});

test('R39: concurrent initialisers commit one identity and registry entry', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    initialiseContext({ config: f.file }, f.options),
    initialiseContext({ config: f.file }, f.options),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(refused.reason instanceof ContextError);
  assert.ok(['storage_busy', 'context_registered'].includes(refused.reason.code));
  const context = await openContext({ context: 'example' }, f.options);
  using database = context.database;
  assert.equal(database.events().length, 2);
});

test('R39: malformed registry and retained pool contents refuse without replacement or allocation cleanup', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.config', 'docket'), { recursive: true });
  await writeFile(f.registry, '{not a registry');
  await assert.rejects(initialiseContext({ config: f.file }, f.options), (error: unknown) => error instanceof ConfigurationError && error.field === '$registry');
  assert.equal(await readFile(f.registry, 'utf8'), '{not a registry');
  await assert.rejects(lstat(f.config.stateDirectory), { code: 'ENOENT' });
  await writeFile(f.registry, '{}');
  await mkdir(f.config.workspace.poolRoot, { recursive: true });
  await writeFile(join(f.config.workspace.poolRoot, 'retained'), 'allocation');
  await assert.rejects(initialiseContext({ config: f.file }, f.options), contextError('context_mismatch'));
  assert.equal(await readFile(join(f.config.workspace.poolRoot, 'retained'), 'utf8'), 'allocation');
  assert.equal(await readFile(f.registry, 'utf8'), '{}');
  await assert.rejects(lstat(f.config.databasePath), { code: 'ENOENT' });
});

test('R01/R29: missing or mismatched registry names refuse, and a read-only open creates no missing context', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveContext({ context: 'absent' }, f.options), contextError('not_initialised'));
  await assert.rejects(openContext({ config: f.file }, f.options), contextError('not_initialised'));
  await assert.rejects(lstat(f.config.stateDirectory), { code: 'ENOENT' });
  await mkdir(join(f.home, '.config', 'docket'), { recursive: true });
  await writeFile(f.registry, JSON.stringify({ wrong: f.file }));
  await assert.rejects(resolveContext({ context: 'wrong' }, f.options), contextError('context_mismatch'));
});
