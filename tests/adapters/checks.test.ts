import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitRepository } from '../../src/adapters/repository.ts';
import { checkCommandRunner } from '../../src/adapters/checks.ts';
import { runCandidateChecks } from '../../src/checks.ts';
import { checkFixture, contextChecks, person, profile } from '../helpers/check-attempt.ts';

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

test('R16/A35: timeout and spawn failure never pass; a signal-killed command remains uncertain', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = checkCommandRunner(environment);
  const timeout = await run(check('setInterval(()=>{}, 1000)', 100), root);
  assert.equal(timeout.status, 'failed'); assert.equal(timeout.timedOut, true);
  const missing = await run({ name: 'missing', command: [join(root, 'nonexistent')], timeoutMs: 1000 }, root);
  assert.equal(missing.status, 'not_run'); assert.equal(missing.exitCode, null);
  const signal = await run(check("process.kill(process.pid, 'SIGKILL')"), root);
  assert.equal(signal.status, 'uncertain'); assert.equal(signal.exitCode, null);
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
    const result = await runCandidateChecks(f.db, a.id, person, { profile, repository: repo, run: checkCommandRunner(environment) });
    assert.equal(result.state, mutation === 'ignored' ? 'succeeded' : 'rejected', mutation);
    assert.equal(result.result!.status, mutation === 'ignored' ? 'passed' : 'failed', mutation);
  }
});
