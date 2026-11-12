import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitRepository } from '../../src/adapters/repository.ts';
import { checkCommandRunner } from '../../src/adapters/checks.ts';
import { confirmed } from '../../src/adapters/command.ts';
import { parseCheckPolicy } from '../../src/check-policy.ts';
import { runCandidateChecks } from '../../src/checks.ts';
import { checkFixture, contextChecks, head, person, profile, start } from '../helpers/check-attempt.ts';
import { defer } from '../helpers/cleanup.ts';

const check = (script: string, timeoutMs = 2000) => ({ name: 'command', command: [process.execPath, '-e', script], timeoutMs });
const environment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };

test('R16/A35: real commands have no stdin, shell or DOCKET variables and diagnostics are bounded and redacted', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = checkCommandRunner({ ...environment, DOCKET_SECRET: 'private', DOCKET_DATABASE: '/private', SAFE: 'safe' }, ['literal-credential']);
  const result = await run(check(`const fs=require('node:fs'); console.log(JSON.stringify({docket:Object.keys(process.env).filter(k=>k.startsWith('DOCKET_')),safe:process.env.SAFE,input:fs.readFileSync(0,'utf8')})); console.log('literal-credential token=hidden https://user:password@example.com'); console.error('x'.repeat(100000));`), root);
  assert.equal(result.status, 'passed');
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { docket: [], safe: 'safe', input: '' });
  assert.ok(!result.stdout.includes('literal-credential')); assert.ok(!result.stdout.includes('hidden')); assert.ok(!result.stdout.includes('user:password'));
  assert.ok(result.stderr.length <= 8192); assert.equal(result.truncated, true);
  const literal = await run({ name: 'literal', command: [process.execPath, '-e', 'console.log(process.argv[1])', '$(touch SHOULD_NOT_EXIST)'], timeoutMs: 2000 }, root);
  assert.equal(literal.stdout.trim(), '$(touch SHOULD_NOT_EXIST)');
  const clipped = await run(check("console.log('x'.repeat(9000))"), root);
  assert.equal(clipped.stdout.length, 8192); assert.equal(clipped.truncated, true);
});

test('R16/A35: timeout fails, spawn failure does not run, and self-kill uses the platform ending', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = checkCommandRunner(environment);
  const timeout = await run(check('setInterval(()=>{}, 1000)', 100), root);
  assert.equal(timeout.status, 'failed'); assert.equal(timeout.timedOut, true);
  const missing = await run({ name: 'missing', command: [join(root, 'nonexistent')], timeoutMs: 1000 }, root);
  assert.equal(missing.status, 'not_run'); assert.equal(missing.exitCode, null);
  const signal = await run(check("process.kill(process.pid, 'SIGKILL')"), root);
  assert.equal(signal.status, process.platform === 'win32' ? 'failed' : 'uncertain');
  assert.equal(signal.signal, process.platform === 'win32' ? null : 'SIGKILL');
  assert.equal(signal.exitCode, process.platform === 'win32' ? 1 : null);
  const failure = await run(check('process.exit(1)'), root);
  assert.equal(failure.status, 'failed'); assert.equal(failure.exitCode, 1);
});

test('R16/A35: timeout stops the whole tree, including a descendant ignoring SIGTERM with inherited or closed pipes', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-timeout-tree-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  for (const pipes of ['inherit', 'ignore']) {
    const pidFile = join(root, `${pipes}.json`);
    defer(t, async () => {
      const pids: number[] = JSON.parse(await readFile(pidFile, 'utf8').catch(() => '[]'));
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    });
    const descendant = "process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => process.exit(0), 15000)";
    const script = `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        { stdio: ['ignore', ${pipes === 'inherit' ? '1, 2' : "'ignore', 'ignore'"}, 'ipc'] });
      child.once('message', () => {
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
        child.disconnect();
      });
      setInterval(() => {}, 1000);`;
    const result = await checkCommandRunner(environment)(check(script, 3000), root);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 'failed');
    const pids: number[] = JSON.parse(await readFile(pidFile, 'utf8'));
    assert.equal(pids.length, 2, 'both processes started before the timeout');
    async function running(pid: number): Promise<boolean> {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
      // A killed orphan can await reaping by init on Linux; it cannot execute or hold pipes.
      if (process.platform === 'linux') {
        const stat = await readFile(join('/proc', String(pid), 'stat'), 'utf8').catch(() => '');
        return stat !== '' && !/^.*\) Z /.test(stat);
      }
      return true;
    }
    for (const pid of pids) {
      for (let tries = 0; tries < 100 && await running(pid); tries++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await running(pid), false, `check process ${pid} stopped`);
    }
  }
});

test('R16/A35: crashes fail and interruptions stay uncertain with observed termination diagnostics', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-ending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = checkCommandRunner(environment);
  if (process.platform === 'win32') {
    for (const code of [0xC0000005, 0xC000001D, 0xC000013A]) {
      const result = await run(check(`process.exit(${code})`), root);
      assert.equal(result.status, code === 0xC000013A ? 'uncertain' : 'failed');
      assert.equal(result.exitCode! >>> 0, code); assert.equal(result.signal, null);
    }
  } else {
    for (const signal of ['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']) {
      // exec replaces the shell so core dumps can be disabled without changing the observed signal.
      const result = await run({ name: 'ending', command: ['/bin/sh', '-c', 'ulimit -c 0; exec "$@"', 'check',
        process.execPath, '-e', `process.kill(process.pid, '${signal}')`], timeoutMs: 2000 }, root);
      assert.equal(result.status, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'].includes(signal) ? 'uncertain' : 'failed', signal);
      assert.equal(result.signal, signal); assert.equal(result.exitCode, null);
    }
  }
});

test('R16/A35: open descendant pipes keep both successful and nonzero exits uncertain and retain the slot', async t => {
  for (const code of [0, 1]) {
    const f = await checkFixture(t);
    // The IPC acknowledgement proves the descendant is alive with inherited pipes before exit.
    // A bounded lifetime is a fallback if an assertion interrupts cleanup.
    const descendant = "process.send('ready'); setTimeout(() => process.exit(0), 10000)";
    const definition = check(`const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2, 'ipc'] });
      child.once('message', () => { console.log(child.pid); child.disconnect(); process.exit(${code}); });`, 5000);
    const policy = JSON.stringify({ version: 1, fast: [], full: [definition] });
    const a = await f.attempt('one', ['Criterion'], undefined, head, start, policy);
    const b = await f.attempt('two', ['Criterion'], undefined, head, start, policy);
    const realRun = checkCommandRunner(environment);
    let commands = 0;
    const services = { profile, repository: {
      readCheckPolicy: async () => parseCheckPolicy(start, policy, contextChecks),
      identity: async () => confirmed('/repo'),
      inspectRef: async () => confirmed({ state: 'present' as const, commit: head }),
      inspectWorkspace: async () => confirmed({ branch: 'refs/heads/worker', head, clean: true, uncommitted: [], untracked: [] }),
    }, run: async () => {
      commands++;
      const result = await realRun(definition, f.root);
      const pid = Number(result.stdout.trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      t.after(() => { try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } });
      assert.equal(result.status, 'uncertain'); assert.equal(result.exitCode, code);
      return result;
    } };
    assert.equal((await runCandidateChecks(f.db, a.id, person, services)).state, 'uncertain');
    assert.equal((await runCandidateChecks(f.db, b.id, person, services)).state, 'pending');
    assert.equal((await runCandidateChecks(f.db, a.id, person, services, 'new-request')).state, 'pending');
    assert.equal(commands, 1);
    assert.equal(f.db.claims().filter(value => value.role === 'check_executor' && !value.releasedAt).length, 1);
  }
});

test('R15: Git reads exact target content without checkout; worker changes cannot relax it; absence differs from malformed', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = new GitRepository({ repository: root });
  async function git(...args: string[]) { const result = await repo.command(args); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); }
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(join(root, 'file'), 'base'); await git('add', '.'); await git('commit', '-m', 'Base');
  const absent = await repo.readCheckPolicy('refs/heads/main', contextChecks); assert.equal(absent.present, false);
  await mkdir(join(root, '.docket'));
  const original = JSON.stringify({ version: 1, fast: [], full: [check('process.exit(1)')] });
  await writeFile(join(root, '.docket/checks.json'), original); await git('add', '.'); await git('commit', '-m', 'Trusted policy');
  const source = await git('rev-parse', 'HEAD');
  await git('switch', '-c', 'worker');
  await writeFile(join(root, '.docket/checks.json'), '{"version":1,"fast":[],"full":[]}'); await git('commit', '-am', 'Worker weakens policy');
  const before = await git('rev-parse', 'HEAD');
  const trusted = await repo.readCheckPolicy('refs/heads/main', contextChecks);
  assert.equal(trusted.sourceCommit, source); assert.equal(trusted.full.length, 1);
  assert.equal(trusted.sourceDigest, createHash('sha256').update(original).digest('hex')); 
  assert.equal(await git('rev-parse', 'HEAD'), before); assert.equal((await repo.inspectWorkspace(root)).status, 'confirmed');
  assert.equal(await readFile(join(root, '.docket/checks.json'), 'utf8'), '{"version":1,"fast":[],"full":[]}');
  await writeFile(join(root, '.docket/checks.json'), '{bad'); await git('commit', '-am', 'Bad policy');
  await assert.rejects(repo.readCheckPolicy('refs/heads/worker', contextChecks), /JSON/);
  await assert.rejects(repo.readCheckPolicy('refs/heads/missing', contextChecks), /target/);
  await git('rm', '.docket/checks.json');
  await git('update-index', '--add', '--cacheinfo', '120000', await git('hash-object', '-w', 'file'), '.docket/checks.json');
  await git('commit', '-m', 'Policy is a symbolic link');
  await assert.rejects(repo.readCheckPolicy('refs/heads/worker', contextChecks), /regular file/);
});

test('R16/A35: candidate checks with real Git fail tracked/untracked mutations and hidden index entries, allowing ignored generated files', async t => {
  for (const mutation of ['tracked', 'untracked', 'ignored', 'timeout', 'unstartable', 'hidden-index']) {
    const f = await checkFixture(t);
    const workspace = join(f.root, 'pool', 'repository'); await mkdir(workspace, { recursive: true });
    const repo = new GitRepository({ repository: workspace });
    async function git(...args: string[]) { const result = await repo.command(args); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); }
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
    await writeFile(join(workspace, 'file'), 'base'); await writeFile(join(workspace, '.gitignore'), 'generated\n');
    const script = mutation === 'tracked' ? "require('node:fs').writeFileSync('file','changed')"
      : mutation === 'untracked' ? "require('node:fs').writeFileSync('new-file','new')"
      : mutation === 'ignored' ? "require('node:fs').writeFileSync('generated','new')" : 'setInterval(()=>{},1000)';
    const definition = mutation === 'unstartable' ? { name: 'missing', command: [join(workspace, 'missing')], timeoutMs: 1000 } : check(script, mutation === 'timeout' ? 100 : 2000);
    const content = JSON.stringify({ version: 1, fast: [], full: [definition] });
    await mkdir(join(workspace, '.docket')); await writeFile(join(workspace, '.docket/checks.json'), content);
    await git('add', '.'); await git('commit', '-m', 'Base'); const base = await git('rev-parse', 'HEAD');
    await git('switch', '-c', 'worker'); await writeFile(join(workspace, 'file'), 'candidate'); await git('commit', '-am', 'Candidate');
    const candidate = await git('rev-parse', 'HEAD');
    if (mutation === 'hidden-index') await git('update-index', '--assume-unchanged', 'file');
    const a = await f.attempt('task', ['Criterion'], workspace, candidate, base, content);
    await git('update-ref', a.binding.outputRef, candidate);
    if (mutation === 'hidden-index') {
      await assert.rejects(runCandidateChecks(f.db, a.id, person, { profile, repository: repo, run: checkCommandRunner(environment) }),
        { code: 'owner_unknown' });
      continue;
    }
    const result = await runCandidateChecks(f.db, a.id, person, { profile, repository: repo, run: checkCommandRunner(environment) });
    assert.equal(result.state, mutation === 'ignored' ? 'succeeded' : 'rejected', mutation);
    assert.equal(result.result!.status, mutation === 'ignored' ? 'passed' : 'failed', mutation);
  }
});
