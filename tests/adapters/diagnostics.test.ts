import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsDirectory } from '../../src/adapters/diagnostics.ts';
import { defer } from '../helpers/cleanup.ts';

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
