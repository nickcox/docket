import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openContext } from '../../src/context.ts';
import { configuration } from '../fixtures/configuration.ts';

interface ChildMessage {
  phase: string;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
}

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-registry-lock-')));
  defer(t, () => rm(home, { recursive: true, force: true }));
  const registry = join(home, '.config', 'docket', 'contexts.json');
  async function config(name: string, id = name, sharedPool?: string) {
    const value = configuration(home, id);
    if (sharedPool) value.workspace.poolRoot = sharedPool;
    const file = join(home, `${name}.json`);
    await writeFile(file, JSON.stringify(value));
    return file;
  }
  async function child(file: string, pause = '') {
    const process = fork(new URL('../helpers/context-child.ts', import.meta.url), [home, file, pause], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages: ChildMessage[] = [];
    let notify: (() => void) | undefined;
    let stderr = '';
    process.stderr!.on('data', chunk => { stderr += chunk; });
    process.on('message', message => { messages.push(message as ChildMessage); notify?.(); });
    const exited = once(process, 'exit');
    defer(t, async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; });
    async function phase(name: string) {
      for (;;) {
        const index = messages.findIndex(message => message.phase === name);
        if (index !== -1) return messages.splice(index, 1)[0]!;
        await Promise.race([
          new Promise<void>(resolve => { notify = resolve; }),
          exited.then(() => { throw new Error(`Child exited waiting for ${name}: ${stderr}`); }),
        ]);
      }
    }
    await phase('ready');
    process.send('go');
    return { process, phase, exited };
  }
  return { home, registry, config, child };
}

for (const stage of ['before-database', 'before-replace', 'after-replace']) {
  test(`R39: killing an initialiser ${stage} releases the lock and leaves no entry or a complete entry`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const file = await f.config('first');
    const first = await f.child(file, stage);
    await first.phase('paused');
    first.process.kill('SIGKILL');
    await first.exited;
    if (stage === 'after-replace') {
      assert.deepEqual(JSON.parse(await readFile(f.registry, 'utf8')), { first: file });
      const context = await openContext({ context: 'first' }, { home: f.home });
      using database = context.database;
      assert.deepEqual(database.events().map(event => event.kind), ['database.initialised', 'context.configured']);
    } else {
      await assert.rejects(readFile(f.registry), { code: 'ENOENT' });
    }
    // An interrupted database commit is not silently adopted. A fresh context
    // must still be able to register without clearing any lock or temporary file.
    const nextFile = stage === 'before-database' ? file : await f.config('next');
    const next = await f.child(nextFile);
    const result = await next.phase('result');
    assert.ok(result.result, JSON.stringify(result));
  });
}

for (const collision of ['name', 'pool', 'database', 'none']) {
  test(`R39: independent initialisers serialise registry checks (${collision} collision)`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const firstFile = await f.config('first');
    const secondFile = await f.config('second', collision === 'name' ? 'first' : 'second', collision === 'pool' ? configuration(f.home, 'first').workspace.poolRoot : undefined);
    if (collision === 'database') {
      const second = JSON.parse(await readFile(secondFile, 'utf8'));
      second.databasePath = configuration(f.home, 'first').databasePath;
      await writeFile(secondFile, JSON.stringify(second));
    }
    const first = await f.child(firstFile, 'before-database');
    await first.phase('paused');
    const second = await f.child(secondFile);
    await second.phase('attempting');
    first.process.send('continue');
    assert.ok((await first.phase('result')).result);
    const result = await second.phase('result');
    if (collision === 'none') assert.ok(result.result, JSON.stringify(result));
    else assert.equal(result.code, collision === 'name' ? 'context_registered' : 'context_mismatch');
    assert.deepEqual(JSON.parse(await readFile(f.registry, 'utf8')), collision === 'none' ? { first: firstFile, second: secondFile } : { first: firstFile });
  });
}
