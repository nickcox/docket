import { defer } from '../helpers/cleanup.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PiLauncher } from '../../src/adapters/pi.ts';
import { PiFrames } from '../../src/adapters/pi-rpc.ts';
import type { WorkerBinding } from '../../src/adapters/launcher.ts';
import type { WorkerReference } from '../../src/storage/launch.ts';
import type { JsonObject } from '../../src/storage/database.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode = '', sdk = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-pi-'));
  const cwd = join(root, 'lease'); await mkdir(cwd);
  const record = join(root, 'peer.jsonl');
  const auth = join(root, 'host-auth.json'), models = join(root, 'host-models.json');
  if (sdk) {
    await writeFile(auth, JSON.stringify({ synthetic: 'credential' }));
    await writeFile(models, JSON.stringify({ providers: {} }));
    await symlink(auth, join(root, 'auth-link.json'));
  }
  let permitted = false;
  let admissionHook: (() => Promise<void>) | undefined;
  const profile = { launcher: 'pi', provider: 'synthetic-provider', model: 'exact-model', reasoning: 'high', executionProfile: 'isolated' };
  const binding: WorkerBinding = { databaseId: randomUUID(), contextId: 'test', taskId: 'task', attemptId: randomUUID(),
    resultPath: join(root, 'attempt', 'result.json'), sessionId: randomUUID(), profileDigest: 'digest', owner: { claimId: randomUUID(), generation: 'generation' },
    specification: { version: 1, resultPath: join(root, 'attempt', 'result.json'), profile, task: { instructions: 'Write the assigned task\nwith Unicode \u2028 intact.' }, criteria: ['Do it'],
      delivery: { kind: 'code', requiredEvidence: ['tests'], requiredDeliverables: [] } },
    allocation: { leaseId: 'lease', holder: {}, path: cwd, pool: root, repository: {}, outputRef: 'refs/heads/output', startingCommit: 'a'.repeat(40) } };
  const launcher = new PiLauncher({ stateDirectory: join(root, 'state'), requestMs: 2000, stopMs: 1000, maxRecordBytes: 4096,
    profiles: { isolated: { executable: process.execPath,
      ...(sdk ? { sdkModule: resolve('tests/fixtures/pi-sdk-peer.ts'), agentFiles: { auth: join(root, 'auth-link.json'), models } }
        : { entrypoint: resolve('tests/fixtures/pi-peer.ts'), credentialVariable: 'PROVIDER_KEY' }),
      passEnvironment: ['PEER_RECORD', 'PEER_MODE', 'EXTRA_APPROVED'] } },
    environment: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LANG: 'en_AU.UTF-8', HTTP_PROXY: 'http://proxy.invalid',
      HTTPS_PROXY: 'https://proxy.invalid', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1', PROVIDER_KEY: 'synthetic-secret',
      PEER_RECORD: record, PEER_MODE: mode, EXTRA_APPROVED: 'yes', UNAPPROVED: 'no', DOCKET_DATABASE: 'no', ANOTHER_PROVIDER_KEY: 'no' },
    admit: async (reference, input, effectId, generation) => {
      await admissionHook?.();
      return permitted && reference.sessionId === binding.sessionId
        && JSON.stringify(input) === JSON.stringify(binding.specification) && effectId === 'activate' && generation === binding.owner.generation;
    },
  });
  let reference: WorkerReference | undefined;
  defer(t, async () => { if (reference) await launcher.stop(reference, 'cleanup'); await rm(root, { recursive: true, force: true }); });
  const prepared = await launcher.prepare(binding, 'prepare');
  if (prepared.status === 'confirmed') reference = prepared.value;
  else if (prepared.status === 'uncertain' && prepared.referenceHints) reference = prepared.referenceHints as WorkerReference;
  const records = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { launcher, binding, prepared, reference: reference!, records, root, permit: () => { permitted = true; },
    pauseAdmission: (hook: () => Promise<void>) => { admissionHook = hook; } };
}

test('R31/R35/A14: prepare is non-acting; only matching committed admission sends exactly one protocol-1 prompt', async t => {
  const f = await fixture(t);
  assert.equal(f.prepared.status, 'confirmed');
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 0);
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'rejected');
  f.permit();
  assert.equal((await f.launcher.activate(f.reference, { wrong: true }, 'activate', 'generation')).status, 'rejected');
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'stale')).status, 'rejected');
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'confirmed');
  await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation');
  const prompts = (await f.records()).filter(r => r.type === 'prompt');
  assert.equal(prompts.length, 1);
  const protocol = JSON.parse(prompts[0].message.split('\n\n')[2]);
  assert.equal(protocol.version, 1);
  assert.deepEqual(protocol.identity, { databaseId: f.binding.databaseId, contextId: 'test', taskId: 'task', attemptId: f.binding.attemptId,
    leaseId: 'lease', sessionId: f.binding.sessionId });
  assert.equal(protocol.instructions, (f.binding.specification.task as JsonObject).instructions);
  assert.deepEqual(protocol.criteria, ['Do it']);
  assert.equal(protocol.outputRef, f.binding.allocation.outputRef);
  assert.equal(protocol.resultPath, f.binding.resultPath);
  assert.equal(protocol.questionsDirectory, join(f.root, 'attempt', 'questions'));
  assert.equal(protocol.artefactsDirectory, join(f.root, 'attempt', 'artefacts'));
  assert.equal((await stat(protocol.questionsDirectory)).isDirectory(), true);
  assert.equal((await stat(protocol.artefactsDirectory)).isDirectory(), true);
  assert.equal((await f.launcher.prepare(f.binding, 'prepare')).status, 'uncertain');
  assert.equal((await f.records()).filter(r => r.kind === 'spawn').length, 1);
});

test('R31/R35: concurrent activation consumes only one prompt attempt', async t => {
  const f = await fixture(t); f.permit();
  const replies = await Promise.all([1, 2].map(() => f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')));
  assert.equal(replies.filter(reply => reply.status === 'confirmed').length, 1);
  assert.equal((await f.records()).filter(record => record.type === 'prompt').length, 1);
});

test('R31/R35: concurrent preparation cannot spawn a second child for the same effect or session', async t => {
  const f = await fixture(t);
  const binding = { ...f.binding, sessionId: randomUUID() };
  const replies = await Promise.all([1, 2].map(() => f.launcher.prepare(binding, 'concurrent-prepare')));
  for (const reply of replies) if (reply.status === 'confirmed') {
    defer(t, async () => { await f.launcher.stop(reply.value, 'cleanup-concurrent'); });
  }
  assert.equal(replies.filter(reply => reply.status === 'confirmed').length, 1);
  assert.equal((await f.launcher.prepare(binding, 'another-effect')).status, 'uncertain');
  assert.equal((await f.records()).filter(record => record.kind === 'spawn').length, 2);
});

test('R07/R35: a fence during the admission read prevents even the first prompt', async t => {
  const f = await fixture(t); f.permit();
  let reached!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  f.pauseAdmission(async () => { reached(); await resume; });
  const activating = f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation');
  await paused;
  try { assert.equal((await f.launcher.fence(f.reference, 'fence')).status, 'confirmed'); }
  finally { release(); }
  assert.equal((await activating).status, 'uncertain');
  assert.equal((await f.records()).filter(record => record.type === 'prompt').length, 0);
});

for (const mode of ['lost-ack', 'wrong-ack']) test(`R35/A15: ${mode} is uncertain and never resends the prompt`, async t => {
  const f = await fixture(t, mode); f.permit();
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'uncertain');
  await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation');
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 1);
});

test('R07/R35: turn end and idle are not direct-child exit; fence observes exit and cannot restart', async t => {
  const f = await fixture(t); f.permit();
  const initial = await f.launcher.inspect(f.reference);
  assert.equal(initial.status, 'known');
  if (initial.status === 'known') { assert.equal(initial.turn, 'idle'); assert.equal(initial.terminal, false); }
  await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation');
  // A fresh RPC round trip ensures the preceding turn events were consumed.
  assert.equal((await f.launcher.usage(f.reference)).status, 'reported');
  const ended = await f.launcher.inspect(f.reference);
  assert.equal(ended.status, 'known');
  if (ended.status === 'known') { assert.equal(ended.turn, 'ended'); assert.equal(ended.terminal, false); }
  assert.equal((await f.launcher.fence(f.reference, 'fence')).status, 'confirmed');
  const exited = await f.launcher.inspect(f.reference);
  assert.equal(exited.status, 'known');
  if (exited.status === 'known') {
    assert.equal(exited.worker, 'stopped'); assert.equal(exited.terminal, true); assert.ok(exited.exit);
    if (ended.status === 'known') assert.ok(exited.sequence > ended.sequence);
  }
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'rejected');
  assert.equal((await f.launcher.deliver(f.reference, 'again', 'after_turn', 'deliver')).status, 'rejected');
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 1);
});

test('R31/R08: a reference cannot be adopted by PID, another owner or a changed session', async t => {
  const f = await fixture(t);
  assert.equal((await f.launcher.inspect({ ...f.reference, sessionId: randomUUID() })).status, 'unknown');
  const other = new PiLauncher({ stateDirectory: join(f.root, 'other'), profiles: {}, admit: async () => true });
  assert.equal((await other.inspect(f.reference)).status, 'unknown');
  assert.equal((await other.stop(f.reference, 'stop')).status, 'uncertain');
});

test('R31/R33/R35: exact cwd/provider/model, controlled resources and environment allowlist', async t => {
  const f = await fixture(t);
  const spawn = (await f.records())[0];
  assert.equal(spawn.cwd, f.binding.allocation.path);
  for (const [flag, value] of [['--provider', 'synthetic-provider'], ['--model', 'exact-model'], ['--thinking', 'high'],
    ['--session-id', f.binding.sessionId], ['--tools', 'read,edit,write,bash']]) assert.equal(spawn.args[spawn.args.indexOf(flag) + 1], value);
  for (const flag of ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve']) assert.ok(spawn.args.includes(flag));
  // CoreFoundation can add this variable inside the child on macOS; it is not inherited by the launcher.
  const environmentKeys = Object.keys(spawn.environment).filter(key => process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING');
  const windowsSystem = process.platform === 'win32'
    ? ['LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'USERDOMAIN', 'USERNAME', 'WINDIR'].filter(key => process.env[key] !== undefined) : [];
  const windowsPrivate = process.platform === 'win32' ? ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP'] : [];
  assert.deepEqual(environmentKeys.sort(), ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
    'PROVIDER_KEY', 'PEER_RECORD', 'PEER_MODE', 'EXTRA_APPROVED', ...windowsSystem, ...windowsPrivate].sort());
  for (const key of windowsSystem) assert.equal(spawn.environment[key], process.env[key]);
  if (process.platform === 'win32') {
    assert.equal(spawn.environment.USERPROFILE, spawn.environment.HOME);
    assert.equal(spawn.environment.HOMEDRIVE + spawn.environment.HOMEPATH, spawn.environment.HOME);
    assert.equal(spawn.environment.TEMP, spawn.environment.TMPDIR);
    assert.ok(spawn.environment.TEMP.startsWith(join(f.root, 'state')));
  }
  assert.equal(spawn.environment.PROVIDER_KEY, 'synthetic-secret');
  assert.notEqual(spawn.environment.HOME, f.root);
  assert.ok(spawn.environment.HOME.startsWith(join(f.root, 'state')));
  if (process.platform === 'win32') {
    const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
      '$rules = @((Get-Acl -LiteralPath $env:PRIVATE_HOME).Access | ForEach-Object { ' +
      '@{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; ' +
      'allow = ($_.AccessControlType -eq "Allow"); full = (($_.FileSystemRights -band 2032127) -eq 2032127) } }); ' +
      '@{ owner = $sid; rules = $rules } | ConvertTo-Json -Depth 4'],
    { env: { ...process.env, PRIVATE_HOME: spawn.environment.HOME }, encoding: 'utf8' }));
    assert.ok(acl.rules.length > 0);
    for (const rule of acl.rules) assert.deepEqual(rule, { sid: acl.owner, allow: true, full: true });
  } else {
    assert.equal((await stat(spawn.environment.HOME)).mode & 0o077, 0);
  }
  assert.throws(() => new PiLauncher({ stateDirectory: f.root, profiles: { bad: { executable: process.execPath,
    credentialVariable: 'PROVIDER_KEY', passEnvironment: ['DOCKET_ANYTHING'] } }, admit: async () => true }), /environment/);
});

for (const mode of ['crash', 'malformed', 'oversized', 'malformed-with-result']) test(`R35/A17: ${mode} cannot be mistaken for completion`, async t => {
  const f = await fixture(t, mode); f.permit();
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'uncertain');
  const observation = await f.launcher.inspect(f.reference);
  if (mode === 'crash') {
    // Pipe EOF may arrive before the direct-child exit event. EOF itself is not terminal evidence.
    const stopped = await f.launcher.stop(f.reference, 'observe-crash-exit');
    assert.equal(stopped.status, 'confirmed');
    const exited = await f.launcher.inspect(f.reference);
    assert.equal(exited.status, 'known');
    if (exited.status === 'known') { assert.equal(exited.terminal, true); assert.equal(exited.exit?.code, 17); }
  } else assert.equal(observation.status, 'unknown');
  assert.equal((await f.launcher.result(f.reference)).status, 'rejected');
  await f.launcher.fence(f.reference, 'failure-fence');
  const terminal = await f.launcher.inspect(f.reference);
  assert.equal(terminal.status, 'known');
  if (terminal.status === 'known') { assert.equal(terminal.terminal, true); assert.ok(terminal.failure); }
  assert.equal((await f.launcher.result(f.reference)).status, 'rejected');
});

test('R31/R35: approved OAuth and model files use canonical host paths with no copied token or host resources', async t => {
  const f = await fixture(t, '', true);
  assert.equal(f.prepared.status, 'confirmed');
  const records = await f.records();
  const credentials = records.find(record => record.kind === 'credentials');
  assert.equal(credentials.authPath, join(f.root, 'host-auth.json'));
  assert.equal(credentials.modelsPath, join(f.root, 'host-models.json'));
  assert.equal(credentials.allowModelNetwork, false);
  assert.deepEqual(credentials.auth, { synthetic: 'credential' });
  assert.deepEqual(JSON.parse(await readFile(credentials.authPath, 'utf8')), { refreshed: true });
  assert.deepEqual(records.find(record => record.kind === 'settings').settings, { retry: { enabled: false } });
  assert.deepEqual(records.find(record => record.kind === 'resources'), { kind: 'resources',
    extensions: { extensions: [], errors: [], runtime: {} }, skills: { skills: [], diagnostics: [] },
    prompts: { prompts: [], diagnostics: [] }, themes: { themes: [], diagnostics: [] },
    agents: { agentsFiles: [] }, systemPrompt: null, appendSystemPrompt: [] });
  assert.deepEqual(records.find(record => record.kind === 'sdk_session'), { kind: 'sdk_session',
    model: { provider: 'synthetic-provider', id: 'exact-model' }, tools: ['read', 'edit', 'write', 'bash'], thinkingLevel: 'high' });
  const spawn = records.find(record => record.kind === 'spawn');
  assert.equal(spawn.environment.PROVIDER_KEY, undefined);
  assert.equal(records.filter(record => record.type === 'prompt').length, 0);
  f.permit();
  assert.equal((await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation')).status, 'confirmed');
  assert.equal((await f.records()).filter(record => record.type === 'prompt').length, 1);
});

test('R35: execution profiles reject unapproved agent files and require explicit SDK selection', () => {
  for (const profile of [
    { executable: process.execPath, passEnvironment: [], agentFiles: { auth: '/host/auth.json' } },
    { executable: process.execPath, passEnvironment: [], sdkModule: '/pi/index.js', agentFiles: { settings: '/host/settings.json' } },
    { executable: process.execPath, passEnvironment: [], sdkModule: '/pi/index.js', agentFiles: { auth: 'relative/auth.json' } },
    { executable: process.execPath, passEnvironment: [], sdkModule: '/pi/index.js', entrypoint: '/pi/cli.js' },
  ]) assert.throws(() => new PiLauncher({ stateDirectory: '/state', profiles: { invalid: profile }, admit: async () => true }), /agent file/);
});

test('R35: model mismatch during preparation retains a reference but sends no prompt', async t => {
  const f = await fixture(t, 'wrong-provider');
  assert.equal(f.prepared.status, 'uncertain'); assert.equal(f.reference.launcher, 'pi');
  assert.equal((await f.records()).filter(r => r.type === 'prompt').length, 0);
});

test('R20/R31: usage is session cumulative and remains available after exit', async t => {
  const f = await fixture(t);
  const first = await f.launcher.usage(f.reference), second = await f.launcher.usage(f.reference);
  assert.equal(first.status, 'reported'); assert.equal(second.status, 'reported');
  if (first.status === 'reported' && second.status === 'reported') {
    assert.deepEqual(second.metrics, { tokens: 123, cost: 0.004 }); assert.ok(second.sequence > first.sequence);
    assert.equal(second.sourceId, f.reference.ownerId);
  }
  await f.launcher.stop(f.reference, 'stop');
  assert.deepEqual(await f.launcher.usage(f.reference), second);
});
test('R20: zero usage is reported, while regressing cumulative usage is unknown', async t => {
  const zero = await fixture(t, 'zero-usage');
  const report = await zero.launcher.usage(zero.reference);
  assert.equal(report.status, 'reported');
  if (report.status === 'reported') assert.deepEqual(report.metrics, { tokens: 0, cost: 0 });
  const regressing = await fixture(t, 'regressing-usage');
  assert.equal((await regressing.launcher.usage(regressing.reference)).status, 'reported');
  assert.equal((await regressing.launcher.usage(regressing.reference)).status, 'unknown');
});
for (const mode of ['missing-usage', 'unsupported-usage']) test(`R20: ${mode} is never reported as zero`, async t => {
  const f = await fixture(t, mode);
  assert.equal((await f.launcher.usage(f.reference)).status, mode === 'unsupported-usage' ? 'unsupported' : 'unknown');
});

test('R31/R35: result transport refers only to a bounded retained regular file, not acceptance', async t => {
  const f = await fixture(t, 'result'); f.permit();
  await f.launcher.activate(f.reference, f.binding.specification, 'activate', 'generation');
  await f.launcher.usage(f.reference);
  const result = await f.launcher.result(f.reference);
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') return;
  const path = String(result.value.reference.path);
  assert.equal(result.value.transport, 'regular_file');
  await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await f.launcher.result(f.reference)).status, 'rejected');
  await rm(path); await symlink(join(f.root, 'peer.jsonl'), path);
  assert.equal((await f.launcher.result(f.reference)).status, 'rejected');
});

test('R31: returned references, usage and exit observations cannot mutate owner state', async t => {
  const f = await fixture(t);
  const repeated = await f.launcher.prepare(f.binding, 'prepare');
  assert.equal(repeated.status, 'uncertain');
  if (repeated.status === 'uncertain') (repeated.referenceHints as WorkerReference).sessionId = 'changed';
  assert.equal((await f.launcher.inspect(f.reference)).status, 'known');
  const report = await f.launcher.usage(f.reference);
  if (report.status === 'reported') report.metrics.tokens = 999999;
  assert.equal((await f.launcher.usage(f.reference)).status, 'reported');
  await f.launcher.stop(f.reference, 'stop');
  const observed = await f.launcher.inspect(f.reference);
  if (observed.status === 'known' && observed.exit) observed.exit.code = 17;
  const next = await f.launcher.inspect(f.reference);
  if (next.status === 'known') { assert.notEqual(next.exit?.code, 17); assert.equal(next.failure, undefined); }
});

test('R35: optional real Pi prepares without a model request and fences by direct-child exit', {
  skip: process.env.DOCKET_TEST_REAL_PI !== '1',
}, async t => {
  const executable = process.env.DOCKET_TEST_PI_EXECUTABLE;
  const provider = process.env.DOCKET_TEST_PI_PROVIDER;
  const model = process.env.DOCKET_TEST_PI_MODEL;
  assert.ok(executable && provider && model, 'Set DOCKET_TEST_PI_EXECUTABLE (absolute), DOCKET_TEST_PI_PROVIDER and DOCKET_TEST_PI_MODEL');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'docket-real-pi-'));
  const cwd = join(root, 'lease'); await mkdir(cwd);
  const launcher = new PiLauncher({ stateDirectory: join(root, 'state'), requestMs: 15000,
    profiles: { real: { executable,
      ...(process.env.DOCKET_TEST_PI_SDK_MODULE ? { sdkModule: process.env.DOCKET_TEST_PI_SDK_MODULE,
        agentFiles: { ...(process.env.DOCKET_TEST_PI_AUTH_FILE ? { auth: process.env.DOCKET_TEST_PI_AUTH_FILE } : {}),
          ...(process.env.DOCKET_TEST_PI_MODELS_FILE ? { models: process.env.DOCKET_TEST_PI_MODELS_FILE } : {}) } } : {}),
      ...(process.env.DOCKET_TEST_PI_CREDENTIAL_VARIABLE ? { credentialVariable: process.env.DOCKET_TEST_PI_CREDENTIAL_VARIABLE } : {}), passEnvironment: [] } },
    admit: async () => false });
  let reference: WorkerReference | undefined;
  defer(t, async () => { if (reference) await launcher.stop(reference, 'cleanup'); await rm(root, { recursive: true, force: true }); });
  const prepared = await launcher.prepare({ databaseId: randomUUID(), contextId: 'probe', taskId: 'probe', attemptId: randomUUID(),
    resultPath: join(root, 'attempt', 'result.json'), sessionId: randomUUID(), profileDigest: 'probe', owner: { claimId: randomUUID(), generation: 'probe' },
    specification: { resultPath: join(root, 'attempt', 'result.json'), profile: { launcher: 'pi', provider, model, reasoning: null, executionProfile: 'real' },
      task: { instructions: 'No prompt is authorised in this probe.' }, criteria: [], delivery: {} },
    allocation: { leaseId: 'probe', holder: {}, path: cwd, pool: root, repository: {}, outputRef: 'refs/heads/probe', startingCommit: 'a'.repeat(40) } }, 'prepare');
  if (prepared.status === 'confirmed') reference = prepared.value;
  else if (prepared.status === 'uncertain') reference = prepared.referenceHints as WorkerReference;
  assert.equal(prepared.status, 'confirmed');
  const observed = await launcher.inspect(reference!);
  assert.equal(observed.status, 'known');
  if (observed.status === 'known') { assert.equal(observed.turn, 'idle'); assert.equal(observed.terminal, false); }
  assert.equal((await launcher.providerReady(reference!)).status, 'confirmed', 'Pi must report the configured provider/model as ready');
  assert.equal((await launcher.fence(reference!, 'fence')).status, 'confirmed');
});

test('R35/A17: framing splits UTF-8 safely and refuses malformed, oversized and truncated frames', () => {
  const bytes = Buffer.from('{"type":"event","text":"\u2028☕"}\n');
  const frames = new PiFrames(200);
  const records = [];
  for (const byte of bytes) records.push(...frames.push(Buffer.from([byte])));
  assert.equal(records[0]!.text, '\u2028☕'); frames.finish();
  assert.throws(() => new PiFrames(8).push(Buffer.from('123456789')), /limit/);
  assert.throws(() => new PiFrames(8).push(Buffer.from('123456789\n')), /limit/);
  assert.throws(() => new PiFrames(100).push(Buffer.from('{bad}\n')));
  assert.throws(() => new PiFrames(100).push(Buffer.from('[]\n')), /Invalid/);
  assert.throws(() => new PiFrames(100).push(Buffer.from([255])), /encoded/);
  const truncated = new PiFrames(100); truncated.push(Buffer.from('{"type":"event"}')); assert.throws(() => truncated.finish(), /Unterminated/);
});
