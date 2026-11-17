import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BbLauncher, type BbExecutionProfile } from '../../src/adapters/bb.ts';
import { commandRunner } from '../../src/adapters/command.ts';
import type { WorkerBinding } from '../../src/adapters/launcher.ts';
import { defer } from '../helpers/cleanup.ts';
import { createRuntime, loadExecutionProfiles } from '../../src/runtime.ts';
import type { Database } from '../../src/storage/database.ts';
import type { Configuration } from '../../src/configuration.ts';

async function fixture(t: Parameters<typeof defer>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'docket-bb-'));
  defer(t, () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'leased'); await mkdir(workspace);
  const script = join(root, 'bb.cjs'), state = join(root, 'state.json'), log = join(root, 'calls.jsonl');
  await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(4), state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.appendFileSync(process.argv[3], JSON.stringify({args, sender: process.env.BB_THREAD_ID}) + '\\n');
if (state.refusal && args[1] === 'spawn') { process.stdout.write(JSON.stringify({ok:false,error:{code:state.refusal,message:'refused'}})); process.exit(1); }
if (state.timeout && args[1] === 'spawn') { setTimeout(() => {}, 10000); return; }
if (state.lost === args[1]) { process.stdout.write('{'); process.exit(0); }
let value;
if (args[0] === 'docket') value = args[1] === 'ready' ? {version:1,ready:state.ready} : {requested:true,threadId:'thr_worker'};
else if (args[0] === 'project') value = state.projects;
else if (args[1] === 'spawn') value = {id:'thr_worker'};
else if (args[1] === 'show') value = {thread:{id:'thr_worker',providerId:'pi',status:state.status},environment:{path:state.path}};
else if (args[1] === 'queue') value = [{model:'model'}];
else if (args[1] === 'log') value = state.events;
else if (args[1] === 'stop') value = {ok:true,threadId:'thr_worker'};
else value = {threadId:'thr_worker',delivery:'queued'};
process.stdout.write(JSON.stringify(value));`);
  const current = { ready: true, lost: '', refusal: '', timeout: false, status: 'idle', path: workspace, events: [] as unknown[],
    projects: [{ id: 'proj_local', kind: 'standard', sources: [{ type: 'local_path', hostId: 'host_local', path: root }] }] };
  const save = () => writeFile(state, JSON.stringify(current));
  await save();
  let admitted = true;
  const execution: BbExecutionProfile = { executable: process.execPath, passEnvironment: [], machineId: 'host_local' };
  const launcher = new BbLauncher({ repository: root, profiles: { local: execution },
    admissionMs: 1, admission: () => admitted,
    run: (_file, args, cwd) => commandRunner({ timeoutMs: current.timeout ? 1000 : 60000, environment: { PATH: process.env.PATH } })(process.execPath, [script, state, log, ...args], cwd) });
  const binding = { specification: { profile: { launcher: 'bb', executionProfile: 'local', provider: 'pi', model: 'model', reasoning: null } },
    initialInput: 'exact\ntext\n', allocation: { path: workspace }, sessionId: 'session', resultPath: join(root, 'retained', 'result.json') } as unknown as WorkerBinding;
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, launcher, binding, current, execution, save, calls, deny: () => { admitted = false; } };
}

test('R31: runtime routes profile launchers and validates bb execution settings without changing Pi capabilities', async t => {
  const f = await fixture(t), directory = join(f.root, '.config', 'docket');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'execution-profiles.json');
  const profiles = { version: 1, bb: { local: { executable: process.execPath, passEnvironment: [] } },
    pi: { local: { executable: process.execPath, passEnvironment: [] } }, checks: { node: { id: 'node', tools: {}, dependencies: {} } } };
  await writeFile(path, JSON.stringify(profiles), { mode: 0o600 });
  const options = { windowsSettingsWritableOnlyByOwner: async () => true };
  const runtime = await createRuntime({} as Database, { repository: f.root, stateDirectory: f.root,
    workspace: { poolRoot: f.root }, checks: { executionProfile: 'node' } } as unknown as Configuration, f.root, options);
  assert.equal(runtime.launcher.capabilities({ launcher: 'bb', executionProfile: 'local' }).fenceEnforcement, 'best_effort');
  assert.equal(runtime.launcher.capabilities({ launcher: 'pi', executionProfile: 'local' }).fenceEnforcement, 'enforced');
  assert.equal(runtime.launcher.capabilities({ launcher: 'bb', executionProfile: 'missing' }).admission, false);
  profiles.bb.local.passEnvironment = ['BB_THREAD_ID'] as never[];
  await writeFile(path, JSON.stringify(profiles));
  await assert.rejects(loadExecutionProfiles(f.root, options), /invalid execution profiles schema/);
});

test('R31 R33 R34 A55: protected create preserves exact text, profile and cwd; project readiness refuses before create', async t => {
  const f = await fixture(t);
  f.current.ready = false; await f.save();
  const refused = await f.launcher.prepare(f.binding, 'missing');
  assert.equal(refused.status, 'rejected');
  if (refused.status === 'rejected') {
    assert.match(JSON.stringify(refused.evidence), /Add proj_local.*projects setting/);
    assert.match(JSON.stringify(refused.evidence), /"neverStarted":true/);
  }
  assert.deepEqual((await f.calls()).map(c => c.args), [['project', 'list', '--json'], ['docket', 'ready', 'proj_local']]);
  f.current.ready = true; await f.save();
  const prepared = await f.launcher.prepare(f.binding, 'prepare');
  assert.equal(prepared.status, 'confirmed');
  const args = (await f.calls()).at(-1).args as string[];
  assert.equal(args[args.indexOf('--prompt') + 1], f.binding.initialInput);
  assert.equal(args[args.indexOf('--environment') + 1], f.binding.allocation.path);
  assert.equal(args[args.indexOf('--project') + 1], 'proj_local');
  assert.equal(args[args.indexOf('--machine') + 1], 'host_local');
  assert.equal(args[args.indexOf('--provider') + 1], 'pi');
  assert.equal(args[args.indexOf('--model') + 1], 'model');
  assert.equal(f.launcher.capabilities(f.binding.specification.profile as never).fenceEnforcement, 'best_effort');
});

test('R31 R33 A15: lost create, send and activation replies are uncertain and never repeated', async t => {
  const f = await fixture(t);
  f.current.lost = 'spawn'; await f.save();
  assert.equal((await f.launcher.prepare(f.binding, 'lost')).status, 'uncertain');
  assert.equal((await f.launcher.prepare(f.binding, 'lost')).status, 'uncertain');
  assert.equal((await f.calls()).filter(c => c.args[1] === 'spawn').length, 1);
  f.current.lost = ''; await f.save();
  const prepared = await f.launcher.prepare(f.binding, 'new');
  assert.equal(prepared.status, 'confirmed'); if (prepared.status !== 'confirmed') return;
  const ref = prepared.value;
  f.deny();
  assert.equal((await f.launcher.activate(ref, {}, 'activate', 'generation')).status, 'uncertain');
  assert.equal((await f.launcher.activate(ref, {}, 'activate', 'generation')).status, 'uncertain');
  assert.equal((await f.calls()).filter(c => c.args[1] === 'recheck').length, 1);
  f.current.lost = 'tell'; await f.save();
  assert.equal((await f.launcher.deliver(ref, 'one', 'after_turn', 'send')).status, 'uncertain');
  assert.equal((await f.launcher.deliver(ref, 'one', 'after_turn', 'send')).status, 'uncertain');
  assert.equal((await f.calls()).filter(c => c.args[1] === 'tell').length, 1);
});

test('R31 R33 A15: project lookup refuses absent, ambiguous and foreign-machine sources before spawn; explicit ID overrides', async t => {
  const f = await fixture(t);
  const local = structuredClone(f.current.projects[0]!);
  for (const projects of [[], [local, { ...local, id: 'proj_second' }],
    [{ ...local, sources: [{ ...local.sources[0]!, hostId: 'host_elsewhere' }] }]]) {
    f.current.projects = projects; await f.save();
    const result = await f.launcher.prepare(f.binding, JSON.stringify(projects));
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(JSON.stringify(result.evidence), /bb project create --name <name> --root <repository> --machine <machine>/);
  }
  assert.equal((await f.calls()).filter(c => c.args[1] === 'spawn').length, 0);
  f.execution.projectId = 'proj_explicit';
  const result = await f.launcher.prepare(f.binding, 'explicit');
  assert.equal(result.status, 'confirmed');
  const args = (await f.calls()).at(-1).args as string[];
  assert.equal(args[args.indexOf('--project') + 1], 'proj_explicit');
  assert.equal((await f.calls()).filter(c => c.args[0] === 'project').length, 3);
  assert.deepEqual((await f.calls()).filter(c => c.args[1] === 'ready').map(c => c.args), [['docket', 'ready', 'proj_explicit']]);
});

test('R31 R33 A15: only proven pre-effect validation is rejected; generic envelopes, malformed replies and timeouts remain uncertain without retry', async t => {
  for (const code of ['missing_required', 'invalid_request', 'error']) {
    const f = await fixture(t);
    f.current.refusal = code; await f.save();
    const result = await f.launcher.prepare(f.binding, code);
    assert.equal(result.status, code === 'missing_required' ? 'rejected' : 'uncertain');
    if (result.status === 'rejected') assert.match(JSON.stringify(result.evidence), /missing_required/);
    assert.equal((await f.launcher.prepare(f.binding, code)).status, 'uncertain');
    assert.equal((await f.calls()).filter(c => c.args[1] === 'spawn').length, 1);
  }
  const f = await fixture(t);
  f.current.timeout = true; await f.save();
  assert.equal((await f.launcher.prepare(f.binding, 'timeout')).status, 'uncertain');
  assert.equal((await f.launcher.prepare(f.binding, 'timeout')).status, 'uncertain');
  assert.equal((await f.calls()).filter(c => c.args[1] === 'spawn').length, 1);
});

test('R31 R33 A17: idle is not terminal, turn-end needs stop and fence; usage omits unknown values', async t => {
  const f = await fixture(t), prepared = await f.launcher.prepare(f.binding, 'prepare');
  assert.equal(prepared.status, 'confirmed'); if (prepared.status !== 'confirmed') return;
  const ref = prepared.value;
  assert.equal((await f.launcher.inspect(ref)).status, 'known');
  assert.equal((await f.launcher.usage(ref)).status, 'unknown');
  f.current.events = [
    { threadId: 'thr_worker', seq: 1, type: 'turn/started', data: {} },
    { threadId: 'thr_worker', seq: 2, type: 'turn/completed', data: {} },
    { threadId: 'thr_worker', seq: 3, type: 'thread/tokenUsage/updated', data: { tokenUsage: { total: { inputTokens: 0, outputTokens: 12 } } } },
  ]; await f.save();
  const ended = await f.launcher.inspect(ref);
  assert.ok(ended.status === 'known' && ended.turn === 'ended' && !ended.terminal);
  await f.launcher.fence(ref, 'fence');
  const terminal = await f.launcher.inspect(ref);
  assert.ok(terminal.status === 'known' && terminal.terminal && terminal.sequence === 3);
  assert.deepEqual(await f.launcher.usage(ref), { status: 'reported', sourceId: 'bb:thr_worker', sequence: 3, metrics: { input: 0, output: 12 } });
  assert.equal((await f.launcher.deliver(ref, 'no', 'active_steering', 'late')).status, 'rejected');
  f.current.events.push({ threadId: 'thr_worker', seq: 4, type: 'turn/started', data: {} },
    { threadId: 'thr_worker', seq: 5, type: 'turn/completed', data: {} });
  await f.save();
  const later = await f.launcher.inspect(ref);
  assert.ok(later.status === 'known' && !later.terminal, 'An old stop cannot prove a later turn terminal');
});
