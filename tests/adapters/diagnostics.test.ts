import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DiagnosticsDirectory } from '../../src/adapters/diagnostics.ts';
import { defer } from '../helpers/cleanup.ts';

test('A58/R40: selected worker diagnostics refuse a linked session ancestor and changed start-up file', async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'docket-diagnostics-'));
  defer(t, () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'worker'), retained = join(parent, 'retained');
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(retained);
  await writeFile(join(root, 'home', 'private'), 'private');
  await writeFile(join(root, 'sdk.json'), 'startup');
  await writeFile(join(retained, 'session.jsonl'), 'retained');
  await symlink(retained, join(root, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  const owner = new DiagnosticsDirectory();
  const targets = ['home', 'sdk.json', relative(root, join(root, 'sessions', 'session.jsonl'))];
  await assert.rejects(owner.inspect(root, targets), /linked/);
  // A retained transcript is not inspected or followed when only home is selected.
  const homeManifest = await owner.inspect(root, ['home']);
  await owner.remove(homeManifest);
  assert.equal(await readFile(join(retained, 'session.jsonl'), 'utf8'), 'retained');
  const startupManifest = await owner.inspect(root, ['sdk.json']);
  await writeFile(join(root, 'sdk.json'), 'changed');
  await assert.rejects(owner.remove(startupManifest), /changed/);
  assert.equal(await readFile(join(root, 'sdk.json'), 'utf8'), 'changed');
});

for (const risk of ['symlink', 'hardlink', 'changed', 'new']) test(`A58/R40: diagnostic deletion refuses ${risk} without losing output`, async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'docket-diagnostics-'));
  defer(t, () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'diagnostics'), output = join(parent, 'result.json');
  await mkdir(root);
  await writeFile(output, 'retained');
  const owner = new DiagnosticsDirectory();
  if (risk === 'symlink' || risk === 'hardlink') {
    await (risk === 'symlink' ? symlink : link)(output, join(root, 'log'));
    await assert.rejects(owner.inspect(root), /linked/);
  } else {
    await writeFile(join(root, 'log'), 'original');
    const manifest = await owner.inspect(root);
    await writeFile(join(root, risk === 'changed' ? 'log' : 'new'), 'changed');
    await assert.rejects(owner.remove(manifest), /changed/);
    assert.equal(await readFile(join(root, 'log'), 'utf8'), risk === 'changed' ? 'changed' : 'original');
  }
  assert.equal(await readFile(output, 'utf8'), 'retained');
});
