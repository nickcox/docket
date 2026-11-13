import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, link, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, realEntry } from '../helpers/cli-operations.ts';

test('R17 R28 A37: private host invoke fixes authority, context and operation list without changing ordinary calls', async t => {
  const f = await fixture(t, 'code-result', realEntry);
  const directory = join(f.home, 'host-service');
  const created = f.invoke('host.bind', { directory, operations: ['catalog.show', 'status.watch', 'supervisor.pending'] }, 'create-host');
  assert.equal(created.status, 0, created.stderr);
  assert.equal(f.invoke('host.bind', { directory, operations: ['catalog.show', 'status.watch', 'supervisor.pending'] }, 'create-host').status, 0);
  const path = created.data.path as string;
  assert.equal(path, join(directory, 'binding.json'));
  const original = await readFile(path, 'utf8');
  const binding = JSON.parse(original);
  assert.equal(binding.caller.kind, 'host');
  const input = join(f.home, 'host-input.json');
  const invoke = async (operation = 'catalog.show', args: object = {}, privateFile = path, extra: string[] = []) => {
    await writeFile(input, JSON.stringify(args));
    const result = spawnSync(process.execPath, [realEntry, 'host', 'invoke', operation, '--binding', privateFile,
      '--input', input, '--json', '--request-id', 'host-call', ...extra], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.stdout.split('\n').length, 2, result.stdout);
    return { status: result.status, envelope: JSON.parse(result.stdout) };
  };
  const catalog = await invoke();
  assert.equal(catalog.status, 0);
  assert.deepEqual(catalog.envelope.data.operations.map((op: { name: string }) => op.name).sort(), binding.operations.toSorted());
  assert.equal(catalog.envelope.requestId, 'host-call');
  assert.equal(f.invoke('objective.add', { id: 'goal', request: 'Work', criteria: ['Works'], scope: '', constraints: '',
    permissions: {}, budget: null, deadline: null }).status, 0);
  const pending = { objectiveId: 'goal', afterSequence: 0, timeoutMs: 0 };
  assert.equal(f.invoke('supervisor.pending', pending).envelope.code, 'person_required');
  assert.equal((await invoke('supervisor.pending', pending)).status, 0);
  const request = f.invoke('request.show', { requestId: 'host-call' });
  assert.equal(request.status, 0);
  assert.deepEqual(request.data.caller, binding.caller);
  assert.equal((await invoke('task.list', { state: null, readyOnly: false, page: { after: null, limit: 10 } })).envelope.code, 'person_required');
  for (const args of [{ caller: { kind: 'person', id: 'forged' } }, { config: f.file }, { requestId: 'forged' }]) {
    assert.equal((await invoke('catalog.show', args)).envelope.code, 'invalid_input');
  }
  assert.equal((await invoke('catalog.show', {}, path, ['--config', f.file])).envelope.code, 'invalid_input');
  assert.equal((await invoke('catalog.show', {}, join(f.home, 'absent'))).envelope.code, 'invalid_input');
  const hard = join(directory, 'hard.json');
  await link(path, hard);
  assert.equal((await invoke()).envelope.code, 'invalid_input');
  // Remove the second link before testing other file properties.
  await unlink(hard);
  if (process.platform !== 'win32') {
    const linked = join(directory, 'linked.json');
    await symlink(path, linked);
    assert.equal((await invoke('catalog.show', {}, linked)).envelope.code, 'invalid_input');
    await chmod(path, 0o644);
    assert.equal((await invoke()).envelope.code, 'invalid_input');
    await chmod(path, 0o600);
  }
  for (const value of [{ ...binding, version: 2 }, { ...binding, caller: { kind: 'person', id: 'forged' } }, { ...binding, operations: ['task.add'] }]) {
    await writeFile(path, JSON.stringify(value));
    assert.equal((await invoke()).envelope.code, 'invalid_input');
  }
  for (const field of ['contextId', 'databaseId']) {
    await writeFile(path, JSON.stringify({ ...binding, [field]: 'another-context' }));
    assert.equal((await invoke()).envelope.code, 'context_mismatch');
  }
  await writeFile(path, ' '.repeat(16 * 1024 + 1));
  assert.equal((await invoke()).envelope.code, 'invalid_input');
  await writeFile(path, original);
  assert.equal((await invoke()).status, 0);
  assert.equal(f.invoke('host.bind', { directory: join(f.home, 'bad'), operations: ['task.add'] }).envelope.code, 'invalid_input');
});
