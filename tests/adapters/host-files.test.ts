import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandRunner } from '../../src/adapters/command.ts';
import { loadExecutionProfiles } from '../../src/runtime.ts';
import { windowsPowerShellEnvironment, windowsSettingsWritableOnlyByOwner } from '../../src/adapters/host-files.ts';

test('R29/R31: Windows PowerShell receives no inherited module path on every platform', async () => {
  const original = process.env.PSModulePath;
  process.env.PSModulePath = 'PowerShell-7-only-modules';
  try {
    const environment = { PATH: 'tools', PSModulePath: 'pwsh', pSmOdUlEpAtH: 'pwsh', PRIVATE_HOME: 'private' };
    assert.deepEqual(windowsPowerShellEnvironment(environment), { PATH: 'tools', PRIVATE_HOME: 'private' });
    assert.equal(environment.PSModulePath, 'pwsh');
    assert.equal(await windowsSettingsWritableOnlyByOwner('settings', options => {
      assert.deepEqual(options?.environment, { ...windowsPowerShellEnvironment(), DOCKET_SETTINGS_PATH: 'settings' });
      assert.ok(!Object.keys(options!.environment!).some(key => key.toUpperCase() === 'PSMODULEPATH'));
      return async (executable, args) => {
        assert.equal(executable, 'powershell.exe');
        assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        return { complete: true, code: 0, stdout: '', stderr: '' };
      };
    }), true);
  } finally {
    if (original === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = original;
  }
});

test('R29/R31: untrusted Windows ACLs differ from failed or incomplete verification', async () => {
  for (const result of [
    { complete: true, code: 0 }, { complete: true, code: 2 },
    { complete: true, code: 1 }, { complete: true, code: null },
    { complete: false, code: 0 }, { complete: false, code: 2 }, { complete: true, code: 99 },
  ]) {
    const check = windowsSettingsWritableOnlyByOwner('settings', () => async () => ({
      ...result, stdout: 'credential-that-must-not-appear', stderr: 'module loading or spawn error',
    }));
    if (result.complete && (result.code === 0 || result.code === 2)) {
      assert.equal(await check, result.code === 0);
    } else {
      await assert.rejects(check, { message: 'Windows owner/write ACL could not be verified' });
    }
  }
});

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
    // Read-only access by Everyone is harmless; SYSTEM and Administrators may write.
    const trusted = await run('icacls', [path, '/grant', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)', '*S-1-1-0:(R)'], home);
    assert.equal(trusted.code, 0, trusted.stderr);
    assert.deepEqual(await loadExecutionProfiles(home), profiles);
    const changed = await run('icacls', [path, '/grant', '*S-1-1-0:(W)'], home);
    assert.equal(changed.code, 0, changed.stderr);
  } else {
    await chmod(path, 0o622);
  }
  await assert.rejects(loadExecutionProfiles(home), process.platform === 'win32' ? /Windows owner\/write ACL is untrusted$/ : /group or other write permission/);
});

test('R29/R31: profile refusals name bounded conditions without parser input or credentials', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'docket-profile-refusals-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.config', 'docket'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'execution-profiles.json');
  const secret = 'credential-that-must-not-appear';
  async function refuses(condition: string) {
    await assert.rejects(loadExecutionProfiles(home), (error: Error) => {
      assert.equal(error.message, `$executionProfiles: Cannot read person-controlled execution profiles: ${condition}`);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(home));
      return true;
    });
  }
  await refuses('file metadata could not be read');
  await mkdir(path); await refuses('not a regular file'); await rm(path, { recursive: true });
  await writeFile(path, secret, { mode: 0o600 });
  const alias = join(home, 'alias'); await link(path, alias);
  await refuses('link count is not one'); await rm(alias);
  await refuses('invalid JSON');
  await writeFile(path, JSON.stringify({ version: 1, pi: {}, checks: {}, [secret]: secret }));
  await refuses('invalid execution profiles schema');
  await writeFile(path, JSON.stringify({ version: 1, pi: {}, checks: { node: { id: secret, tools: {}, dependencies: {} } } }));
  await refuses('invalid check profile schema');
  await writeFile(path, secret.repeat(20000)); await refuses('file exceeds 256 KiB');
  await rm(path); await writeFile(alias, '{}', { mode: 0o600 }); await symlink(alias, path);
  await refuses('not a regular file');
});
