import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigurationError, parseConfiguration } from '../../src/configuration.ts';
import { configuration } from '../fixtures/configuration.ts';

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-config-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, config: configuration(home) };
}

function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]));
  return value;
}

function fieldError(field: string) {
  return (error: unknown) => error instanceof ConfigurationError && error.field === field;
}

test('R29: canonical resolved digest ignores whitespace and every object key order', async t => {
  const { config } = await fixture(t);
  const first = await parseConfiguration(JSON.stringify(config));
  const reordered = await parseConfiguration(JSON.stringify(reversed(config), null, 4));
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.digest, reordered.digest);
  assert.deepEqual(first.resolved, config);
  config.keepAwake = false;
  assert.notEqual(first.digest, (await parseConfiguration(JSON.stringify(config))).digest);
});

test('R29: every top-level field is required and unknown top-level or nested fields name their path', async t => {
  const { config } = await fixture(t);
  for (const key of Object.keys(config)) {
    const changed = { ...config } as Record<string, unknown>;
    delete changed[key];
    await assert.rejects(parseConfiguration(JSON.stringify(changed)), fieldError(`$.${key}`));
  }
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, credentials: 'not allowed' })), fieldError('$.credentials'));
  for (const key of ['workspace', 'limits', 'profiles.worker', 'profileByKind', 'finalisation', 'checks', 'supervisor']) {
    const changed = structuredClone(config) as Record<string, unknown>;
    let nested = changed;
    for (const part of key.split('.')) nested = nested[part] as Record<string, unknown>;
    nested.extra = true;
    await assert.rejects(parseConfiguration(JSON.stringify(changed)), fieldError(`$.${key}.extra`));
  }
  for (const source of ['null', '[]', '{', 'true']) await assert.rejects(parseConfiguration(source), fieldError('$'));
  const source = JSON.stringify(config);
  await assert.rejects(parseConfiguration(source.replace('"version":1', '"version":2,"version":1')), fieldError('$.version'));
  await assert.rejects(parseConfiguration(source.replace('"maxAttempts":1', '"maxAttempts":2,"maxAttempts":1')), fieldError('$.limits.maxAttempts'));
});

test('R29: relative, non-normalised and linked paths refuse rather than silently resolve', async t => {
  const { home, config } = await fixture(t);
  for (const key of ['databasePath', 'stateDirectory', 'repository']) {
    for (const value of ['relative/path', `${home}/../other`, `${home}/`]) {
      await assert.rejects(parseConfiguration(JSON.stringify({ ...config, [key]: value })), fieldError(`$.${key}`));
    }
  }
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, workspace: { ...config.workspace, poolRoot: 'pool' } })), fieldError('$.workspace.poolRoot'));
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, finalisation: { ...config.finalisation, globalFile: 'policy.json' } })), fieldError('$.finalisation.globalFile'));
  const linked = join(home, 'linked');
  await symlink(home, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, stateDirectory: join(linked, 'absent') })), fieldError('$.stateDirectory'));
});

test('R29: counts and timeouts are bounded positive integers; budget zero/null is valid', async t => {
  const { config } = await fixture(t);
  for (const key of Object.keys(config.limits)) {
    for (const value of [0, -1, 1.5, 2147483648, '1', null]) {
      await assert.rejects(parseConfiguration(JSON.stringify({ ...config, limits: { ...config.limits, [key]: value } })), fieldError(`$.limits.${key}`));
    }
  }
  for (const value of [0, -1, 0.5, 2147483648, null]) {
    await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profiles: { worker: { ...config.profiles.worker, runMs: value } } })), fieldError('$.profiles.worker.runMs'));
  }
  for (const value of [0, null]) {
    await parseConfiguration(JSON.stringify({ ...config, profiles: { worker: { ...config.profiles.worker, maxCost: value, maxTokens: value } } }));
  }
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profiles: { worker: { ...config.profiles.worker, maxTokens: -1 } } })), fieldError('$.profiles.worker.maxTokens'));
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profiles: { worker: { ...config.profiles.worker, maxCost: -0.1 } } })), fieldError('$.profiles.worker.maxCost'));
});

test('R29: profiles are nonempty, complete and referenced by configured names; check names are unique', async t => {
  const { config } = await fixture(t);
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profiles: {} })), fieldError('$.profiles'));
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, defaultProfile: 'missing' })), fieldError('$.defaultProfile'));
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profileByKind: { ...config.profileByKind, review: 'missing' } })), fieldError('$.profileByKind.review'));
  const incomplete = { ...config.profiles.worker } as Record<string, unknown>;
  delete incomplete.reasoning;
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, profiles: { worker: incomplete } })), fieldError('$.profiles.worker.reasoning'));
  const check = { name: 'types', command: ['npm', 'run', 'check'], timeoutMs: 120000, goalMs: 10000 };
  await parseConfiguration(JSON.stringify({ ...config, checks: { ...config.checks, fast: [check] } }));
  await assert.rejects(parseConfiguration(JSON.stringify({ ...config, checks: { ...config.checks, fast: [check], full: [check] } })), fieldError('$.checks.full[0].name'));
  for (const key of ['timeoutMs', 'goalMs']) {
    await assert.rejects(parseConfiguration(JSON.stringify({ ...config, checks: { ...config.checks, fast: [{ ...check, [key]: 0 }] } })), fieldError(`$.checks.fast[0].${key}`));
  }
});
