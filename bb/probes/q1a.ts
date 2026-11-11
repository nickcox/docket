// Supervisor-only synthetic Q1a/Q1b entry. Never launch this from the worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Harness, until, app } from '../harness/index.ts';
import { controlRequest } from '../harness/http.ts';
import { firstInput } from '../plugin/admission.ts';
import { ProbeReport, validateInputs } from './report.ts';

if (process.argv.length !== 2) throw new Error('Synthetic-only entry accepts no arguments (including --pi)');
const pluginPath = process.env.DOCKET_BB_PROBE_PLUGIN;
if (!pluginPath || realpathSync(pluginPath) === resolve('bb', 'plugin')) throw new Error('Set DOCKET_BB_PROBE_PLUGIN to the separately built scratch plugin');
const manifest = JSON.parse(readFileSync(join(pluginPath, 'package.json'), 'utf8'));
assert.equal(manifest.dependencies['@get-bb/plugin-sdk'], '0.6.132');
assert.equal(process.version, 'v26.7.0');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), '', 'Use a clean committed source candidate');
const hashes: Record<string, string> = {};
for (const name of ['server.ts', 'host.ts', 'admission.ts', 'model.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) {
  const bytes: Buffer = readFileSync(join(pluginPath, name));
  assert.ok(bytes.equals(readFileSync(join('bb', 'plugin', name))), `Scratch source differs: ${name}`);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
for (const name of ['server.js', 'server.meta.json', 'host.js', 'host.meta.json']) {
  hashes[join('dist', name)] = createHash('sha256').update(readFileSync(join(pluginPath, 'dist', name))).digest('hex');
}
const h = new Harness(300_000);
const names = ['startup', 'Q1a held / crash before bind', 'Q1a bound hold / crash after bind', 'Q1a single permit / drain',
  'Q1a ordinary retry / follow-up', 'Q1a permit / fence race', 'Q1b completed fence', 'Q1b enabled backend reload',
  'Q1b enabled server restart', 'Q1b waiting first input crash recovery', 'provider input validation', 'cleanup'];
const reportPath = join(h.root, 'admission-report.json');
const report = new ProbeReport(names, value => writeFileSync(reportPath, JSON.stringify(value, null, 2)));
report.details = { gate: 'Q1a/Q1b synthetic only', source, bb: '0.49.0', sdk: '0.6.132', node: process.version,
  syntheticProvider: `docket-synthetic ${manifest.version}`, piPlugin: JSON.parse(readFileSync(join(app, 'server', 'dist', 'builtin-plugins', 'provider-pi', 'package.json'), 'utf8')).version,
  platform: process.platform, arch: process.arch, timeoutMs: 300_000, root: h.root, pluginPath, sourceAndBundleHashes: hashes,
  limits: ['Independent probe database, not Docket authority/provenance', 'Q1c and Q2 not run', 'No real Pi/model/resource qualification',
    'UI and agent-origin submissions not exercised', 'Steer mode is exercised on an idle/fenced thread, not an active turn',
    'Crash recovery covers a persisted hook wait, not an in-flight callback',
    'Completed-thread retry may be refused by host preconditions; failed-turn retry is exercised separately',
    'Deliberate plugin disable/unload/replacement and Send now are outside the guarantee'] };
report.flush();
console.error(`Synthetic-only retained report: ${reportPath}`);
let token = '';
const auditPath = join(h.root, 'admission.jsonl');
const inputs = (): any[] => {
  const path = join(h.repo, 'provider-inputs.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
const state = () => h.request('/api/v1/plugins/docket-probe/http/state', undefined, token);
const control = async (action: string, threadId?: string, requestId?: string) => {
  const response = await controlRequest(h.url, '/api/v1/plugins/docket-probe/http/control',
    { action, ...(threadId ? { threadId } : {}), ...(requestId ? { requestId } : {}) }, 30_000, token);
  assert.ok([200, 409].includes(response.status), `Unexpected control status ${response.status}`);
  return { status: response.status, ...JSON.parse(response.text) };
};
const count = (id: string) => inputs().filter(row => row.threadId === id).length;
const events = async (id: string) => (await state()).observations.filter((row: any) => row.threadId === id);
const latest = async () => (await state()).observations.at(-1)?.sequence ?? 0;
const observe = async (id: string, after: number, action: string) => until(() => events(id), rows => rows.some((row: any) => row.sequence > after && row.kind === 'dispatch' && row.action === action));
const spawn = (title: string) => {
  const row = JSON.parse(h.cli('thread', 'spawn', '--project', h.projectId, '--environment', h.repo, '--machine', h.hostId,
    '--provider', 'docket-synthetic', '--model', 'synthetic', '--permission-mode', 'full', '--title', title, '--prompt', firstInput, '--json'));
  assert.equal(typeof row.id, 'string');
  return row.id as string;
};
const held = async (id: string) => {
  const queue = await until(async () => JSON.parse(h.cli('thread', 'queue', 'list', id, '--json')), rows =>
    Array.isArray(rows) && rows.some((row: any) => row.waitingOn?.kind === 'plugin' && row.waitingOn.pluginId === 'docket-probe'));
  assert.ok((await events(id)).some((row: any) => row.action === 'wait'));
  assert.equal(count(id), 0);
  return queue;
};
const recheckHeld = async (id: string) => {
  const before = await latest();
  assert.equal((await control('recheck')).status, 200);
  await observe(id, before, 'wait');
  return held(id);
};
const show = (id: string) => JSON.parse(h.cli('thread', 'show', id, '--json')).thread;
const failedRequest = async (id: string) => {
  const rows = await until(() => events(id), rows => rows.some((row: any) => row.kind === 'turn.failed' && row.inputAccepted));
  return rows.findLast((row: any) => row.kind === 'turn.failed' && row.inputAccepted).requestId as string;
};
const rejectLater = async (id: string, retryId?: string) => {
  const beforeCount = count(id);
  const attempts: unknown[] = [];
  for (const mode of ['auto', 'steer']) {
    const before = await latest();
    let refused = false;
    try { h.cli('thread', 'tell', id, `Forbidden ${mode} follow-up`, '--mode', mode, '--json'); }
    catch { refused = true; }
    assert.ok(refused, 'Ordinary send must return refusal');
    const observed = await observe(id, before, 'reject');
    attempts.push({ mode, refused, rejection: observed.filter((row: any) => row.sequence > before) });
  }
  if (retryId) {
    const before = await latest();
    const result = await control('retry', id, retryId);
    const observed = await observe(id, before, 'reject');
    attempts.push({ retryByReference: retryId, result, rejection: observed.filter((row: any) => row.sequence > before) });
  } else {
    // Completed turns have no retryable failed request. Retain the actual host
    // refusal, but do not mislabel it as a dispatch-hook retry observation.
    let refused = false;
    try { h.cli('thread', 'retry', id, '--json'); } catch { refused = true; }
    assert.ok(refused);
    attempts.push({ completedRetry: 'host precondition refused; hook path unproven' });
  }
  assert.equal(count(id), beforeCount);
  return attempts;
};
const snapshot = async () => {
  report.details.providerInputs = inputs();
  report.details.audit = await state();
  report.details.selection = await h.selectedProviders();
  report.flush();
};
let id = '', completedId = '', retryId = '';
const interrupt = () => {
  report.interrupt('Interrupted');
  void h.stop().finally(() => process.exit(130));
};
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await report.stage('startup', async () => {
    await h.start(); h.prepareProject();
    h.cli('plugin', 'config', 'docket-probe', 'set', 'auditPath', auditPath);
    const response = JSON.parse(h.cli('plugin', 'token', 'docket-probe', '--json'));
    assert.equal(response.ok, true); assert.equal(typeof response.token, 'string'); token = response.token;
    return h.selectedProviders();
  });
  await report.stage('Q1a held / crash before bind', async () => {
    id = spawn('Synthetic crash before bind'); await held(id);
    await h.crashServer(); await recheckHeld(id);
    assert.equal((await state()).rows.find((row: any) => row.thread === id).bound, 0);
    return { threadId: id, queue: await held(id) };
  });
  await report.stage('Q1a bound hold / crash after bind', async () => {
    assert.equal((await control('bind', id)).status, 200); await recheckHeld(id);
    await h.crashServer(); await recheckHeld(id);
    assert.equal((await state()).rows.find((row: any) => row.thread === id).bound, 1);
    return { threadId: id, queue: await held(id) };
  });
  await report.stage('Q1a single permit / drain', async () => {
    assert.equal((await control('permit', id)).status, 200);
    await control('recheck');
    await until(async () => count(id), count => count === 1);
    await until(async () => show(id), row => row.status === 'error');
    retryId = await failedRequest(id);
    assert.equal((await control('permit', id)).status, 409, 'Consumed cannot be revived');
    await snapshot(); return { threadId: id, retryId };
  });
  await report.stage('Q1a ordinary retry / follow-up', async () => rejectLater(id, retryId));
  await report.stage('Q1a permit / fence race', async () => {
    const races = [];
    for (let i = 0; i < 4; i++) {
      const raceId = spawn(`Synthetic fence race ${i}`); await held(raceId); await control('bind', raceId);
      const before = await latest();
      const permit = () => control('permit', raceId).then(async result => { await control('recheck'); return result; });
      const results = await Promise.all(i % 2 ? [permit(), control('refuse', raceId)] : [control('refuse', raceId), permit()]);
      await control('recheck');
      // Wait for a real rejection of the queued first input, or a consumed turn
      // reaching error. Neither outcome depends on an arbitrary sleep.
      const observed = await until(() => events(raceId), rows => rows.some((row: any) => row.sequence > before &&
        ((row.kind === 'dispatch' && row.action === 'reject') || row.kind === 'turn.failed')));
      const row = (await state()).rows.find((row: any) => row.thread === raceId);
      assert.equal(row.decision, 'refuse');
      if (row.consumed) {
        await until(() => events(raceId), rows => rows.some((row: any) => row.kind === 'turn.failed' && row.inputAccepted));
        assert.equal(count(raceId), 1);
      } else assert.equal(count(raceId), 0);
      assert.equal((await control('permit', raceId)).status, 409);
      races.push({ threadId: raceId, results, observed, providerInputs: count(raceId) });
    }
    await snapshot(); return races;
  });
  await report.stage('Q1b completed fence', async () => {
    completedId = spawn('Synthetic completed attempt'); await held(completedId);
    writeFileSync(join(h.repo, 'completed-threads.json'), JSON.stringify([completedId]));
    await control('bind', completedId); await control('permit', completedId); await control('recheck');
    await until(async () => count(completedId), count => count === 1);
    await until(async () => show(completedId), row => row.status === 'idle');
    await control('refuse', completedId); await control('refuse', id);
    return { threadId: completedId, attempts: await rejectLater(completedId) };
  });
  for (const boundary of ['Q1b enabled backend reload', 'Q1b enabled server restart']) {
    await report.stage(boundary, async () => {
      const old = (await state()).generation;
      h.cli('thread', 'archive', completedId, '--json');
      if (boundary.endsWith('reload')) {
        const result = await h.request('/api/v1/plugins/reload?id=docket-probe', {}); assert.equal(result.ok, true);
      } else await h.crashServer();
      await until(state, row => row.generation !== old);
      await h.selectedProviders();
      h.cli('thread', 'unarchive', completedId, '--json');
      assert.equal(show(completedId).status, 'idle');
      const completed = await rejectLater(completedId);
      const failed = await rejectLater(id, retryId);
      await snapshot(); return { completed, failed };
    });
  }
  await report.stage('Q1b waiting first input crash recovery', async () => {
    const waiting = spawn('Synthetic waiting crash recovery'); await held(waiting);
    await control('bind', waiting); await recheckHeld(waiting);
    await h.crashServer(); await recheckHeld(waiting);
    // Recovery fences instead of granting permission. A paused creator loses.
    await control('refuse', waiting);
    assert.equal((await control('permit', waiting)).status, 409);
    const before = await latest(); await control('recheck'); await observe(waiting, before, 'reject');
    assert.equal(count(waiting), 0);
    return { threadId: waiting, events: await events(waiting) };
  });
  await report.stage('provider input validation', async () => {
    await snapshot(); validateInputs(inputs(), (await state()).observations);
    return { count: inputs().length, allPrecededByDurableBindingPermissionConsumption: true };
  });
} catch (error) {
  report.failure ??= error instanceof Error ? error.message : 'Probe failed';
  try { await snapshot(); } catch { report.details.finalSnapshot = 'unavailable'; }
  console.error(`Synthetic probe failed; inspect ${reportPath}`); process.exitCode = 1;
} finally {
  try {
    await report.stage('cleanup', async () => {
      await h.stop();
      // Nothing can append after all owned processes stop. Re-read inputs so a
      // late provider admission cannot escape the earlier live snapshot.
      report.details.providerInputs = inputs();
      const finalAudit = report.details.audit as { observations: any[] } | undefined;
      if (finalAudit) validateInputs(inputs(), finalAudit.observations);
      return { guardian: JSON.parse(readFileSync(join(h.root, 'guardian-stopped.json'), 'utf8')),
        stopped: JSON.parse(readFileSync(join(h.root, 'stopped.json'), 'utf8')) };
    });
  } catch { process.exitCode = 1; }
  report.flush(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
