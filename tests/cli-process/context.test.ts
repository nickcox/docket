import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Envelope } from '../../src/response.ts';
import { configuration } from '../fixtures/configuration.ts';

const entry = fileURLToPath(new URL('../../bin/docket.ts', import.meta.url));

function invoke(home: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, 'context', 'init', ...args, '--json'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.split('\n').length, 2);
  return { ...result, envelope: JSON.parse(result.stdout) as Envelope };
}

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-init-cli-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'docket.json');
  const config = configuration(home);
  await writeFile(file, JSON.stringify(config));
  return { home, file, config };
}

test('A01/R39/R27: real context init registers its selected file and --context resolves that same file', async t => {
  const f = await fixture(t);
  const result = invoke(f.home, ['--config', f.file, '--request-id', 'init-1']);
  assert.equal(result.status, 0);
  assert.equal(result.envelope.operation, 'context.init');
  assert.equal(result.envelope.requestId, 'init-1');
  assert.equal(result.envelope.code, 'context_initialised');
  assert.equal(result.envelope.data.configurationFile, f.file);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(await readFile(join(f.home, '.config', 'docket', 'contexts.json'), 'utf8')), { example: f.file });
  const byName = invoke(f.home, ['--context', 'example']);
  assert.equal(byName.status, 1);
  assert.equal(byName.envelope.code, 'context_registered');
  assert.equal(byName.envelope.operation, 'context.init');
});

test('R29/R27: config validation names the refused field; selectors and missing files retain JSON framing', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--context', 'example', '--config', f.file], ['--config'], ['--config', f.file, '--config', f.file]]) {
    const result = invoke(f.home, args);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'invalid_input');
  }
  const missing = invoke(f.home, ['--config', join(f.home, 'missing.json')]);
  assert.equal(missing.status, 2);
  assert.equal(missing.envelope.code, 'invalid_configuration');
  f.config.limits.maxAttempts = 0;
  await writeFile(f.file, JSON.stringify(f.config));
  const invalid = invoke(f.home, ['--config', f.file]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.envelope.code, 'invalid_configuration');
  assert.match(invalid.envelope.diagnostics[0]!.message, /\$\.limits\.maxAttempts/u);
});
