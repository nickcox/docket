import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandRunner } from '../../src/adapters/command.ts';
import { loadExecutionProfiles } from '../../src/runtime.ts';

test('R29/R31: native absolute execution profile paths load only from person-controlled files', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'docket-profiles-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.config', 'docket'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'execution-profiles.json');
  const profiles = { version: 1, pi: { worker: { executable: process.execPath, entrypoint: join(home, 'peer.ts'), passEnvironment: [] } },
    checks: { node: { id: 'node', tools: {}, dependencies: {} } } };
  await writeFile(path, JSON.stringify(profiles), { mode: 0o600 });
  assert.deepEqual(await loadExecutionProfiles(home), profiles);
  if (process.platform === 'win32') {
    const run = commandRunner({ environment: process.env });
    const changed = await run('icacls', [path, '/grant', '*S-1-1-0:(W)'], home);
    assert.equal(changed.code, 0, changed.stderr);
  } else {
    await chmod(path, 0o622);
  }
  await assert.rejects(loadExecutionProfiles(home), /person-controlled execution profiles/);
});
