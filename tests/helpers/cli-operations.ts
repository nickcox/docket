import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { configuration } from '../fixtures/configuration.ts';
import { findOperation } from '../../src/catalog.ts';
import { validateSchema } from '../../src/operation-schemas.ts';

export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      // SQLite may create transient WAL coordination files even on a read-only
      // connection. They contain no new domain writes and are not artefacts.
      if (/\.db-(wal|shm)$/u.test(entry.name)) continue;
      if (entry.isDirectory()) { files[file] = 'directory'; await visit(file); }
      else if (entry.isFile()) files[file] = (await readFile(file)).toString('base64');
    }
  };
  await visit(root); return files;
}
export const entry = fileURLToPath(new URL('../../bin/docket.ts', import.meta.url));
const peer = fileURLToPath(new URL('../fixtures/pi-peer.ts', import.meta.url));
// Repository initialisation is not a CLI boundary. Copy an immutable seed so
// each test still has independent refs, index, configuration and worktree files.
let seed: string;
before(async () => {
  seed = await realpath(await mkdtemp(join(tmpdir(), 'docket-git-seed-')));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: seed, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Tests');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'README'), 'Base\n');
  git('add', '.'); git('commit', '-qm', 'Base');
});
after(() => rm(seed, { recursive: true, force: true }));

export async function fixture(t: test.TestContext, mode = 'code-result') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'docket-operations-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    // Windows PowerShell's settings ACL probe initialises AppData\Roaming under
    // USERPROFILE even with -NoProfile. A real Windows profile already has these
    // folders; create them before snapshots so every other home write is detected.
    await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true });
  }
  const repo = join(home, 'repository'); await cp(seed, repo, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const config = configuration(home); config.repository = repo;
  config.profiles.worker.launcher = 'pi'; config.profiles.worker.executionProfile = 'pi-test'; config.profiles.worker.runMs = 10000;
  config.finalisation.kind = 'local-merge';
  const file = join(home, 'context.json'); await writeFile(file, JSON.stringify(config));
  await mkdir(join(home, '.config', 'docket'), { recursive: true });
  await writeFile(join(home, '.config', 'docket', 'execution-profiles.json'), JSON.stringify({ version: 1,
    pi: { 'pi-test': { executable: process.execPath, entrypoint: peer, passEnvironment: ['PEER_MODE', 'PEER_RECORD'] } },
    checks: { 'node-project-v1': { id: 'node-project-v1', tools: { node: process.version }, dependencies: {} } } }), { mode: 0o600 });
  const invoke = (operation: string, args: object, key?: string, peerMode = mode) => {
    const result = spawnSync(process.execPath, [entry, ...operation.split('.'), '--config', file, '--stdin', '--json', ...(key ? ['--request-id', key] : [])], {
      encoding: 'utf8', input: JSON.stringify(args),
      // A rebase verifies and retains output, runs fresh checks and reattaches
      // the lease. Windows has taken 44 seconds at this real-process boundary.
      timeout: operation === 'attempt.rebase' && !('dryRun' in args && args.dryRun) ? 60000 : 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PEER_MODE: peerMode, PEER_RECORD: join(home, 'peer.jsonl') },
    });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.stdout.split('\n').length, 2, result.stdout);
    const envelope = JSON.parse(result.stdout);
    if (envelope.outcome === 'succeeded') assert.equal(validateSchema(findOperation(operation)!.outputSchema, envelope.data), null, operation);
    return { ...result, envelope, data: envelope.data };
  };
  assert.equal(invoke('context.init', {}).status, 0);
  return { home, repo, git, config, invoke, file };
}
export const definition = { title: 'Implement feature', instructions: 'Implement the feature', criteria: ['Works'], kind: 'code', profile: null };
