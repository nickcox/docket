import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withHarness, until, app } from '../harness/index.ts';

const realPi = process.argv.includes('--pi');
await withHarness(async h => {
  const auditPath = join(h.root, 'admission.jsonl');
  h.cli('plugin', 'config', 'docket-probe', 'set', 'auditPath', auditPath);
  const token = h.cli('plugin', 'token', 'docket-probe').trim();
  const control = async (action: string, threadId?: string) => {
    const response = await fetch(`${h.url}/api/v1/plugins/docket-probe/http/control`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bb-plugin-token': token }, body: JSON.stringify({ action, ...(threadId ? { threadId } : {}) }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, await response.text());
  };
  const audit = (): any[] => existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const inputs = (): any[] => {
    const path = join(h.repo, 'provider-inputs.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const spawn = (title: string, provider = 'docket-synthetic') => JSON.parse(h.cli('thread', 'spawn', '--project', h.projectId, '--environment', h.repo, '--machine', h.hostId,
    '--provider', provider, '--model', provider === 'pi' ? (process.env.DOCKET_BB_PI_MODEL ?? 'anthropic/claude-sonnet-4-5') : 'synthetic', '--permission-mode', 'full', '--title', title, '--prompt', 'Q1a: reply with OK only; do not use tools.', '--json')).id as string;
  const state = async () => h.request('/api/v1/plugins/docket-probe/http/state');
  const count = (id: string) => inputs().filter(row => row.threadId === id).length;
  const held = async (id: string) => {
    await until(async () => JSON.parse(h.cli('thread', 'queue', 'list', id, '--json')), rows => rows.length > 0);
    assert.equal(count(id), 0);
  };
  const results: unknown[] = [];

  // Exercise the actual pi provider's preparation path without admitting input.
  const pi = spawn('Q1a pi held preparation', 'pi');
  await held(pi);
  await control('refuse', pi);
  await control('recheck');
  results.push({ scenario: 'pi preparation only', threadId: pi, providerInputs: 0, admitted: false });

  const id = spawn('Q1a crashes and activation');
  await held(id);
  await h.crashServer(); // Before reference binding.
  await control('recheck');
  assert.equal(count(id), 0);
  assert.equal((await state()).rows.find((row: any) => row.thread === id).bound, 0);
  await control('bind', id);
  await h.crashServer(); // Bound, but no launch permission.
  await control('recheck');
  assert.equal(count(id), 0);
  assert.equal((await state()).rows.find((row: any) => row.thread === id).bound, 1);
  await control('permit', id);
  await control('recheck'); // Ordinary queue drain, never queue send / Send now.
  await until(async () => count(id), count => count === 1);
  await until(async () => JSON.parse(h.cli('thread', 'show', id, '--json')), thread => thread.status === 'error');
  const retry = h.cli('thread', 'retry', id, '--json');
  console.error('Retry:', retry.trim());
  await control('recheck');
  await sleep(500);
  assert.equal(count(id), 1);
  // An ordinary person follow-up must also be rejected.
  let rejected = false;
  try { h.cli('thread', 'tell', id, 'Q1a forbidden follow-up', '--mode', 'auto', '--json'); } catch { rejected = true; }
  assert.ok(rejected);
  results.push({ scenario: 'crash before bind / after bind, drain, retry, follow-up', threadId: id, beforeBind: 0, afterBind: 0, providerInputs: count(id) });

  for (let i = 0; i < 4; i++) {
    const raceId = spawn(`Q1a fence race ${i}`);
    await held(raceId);
    await control('bind', raceId);
    // Independent HTTP requests compete at the plugin's durable decision row.
    await Promise.all(i % 2 ? [control('permit', raceId).then(() => control('recheck')), control('refuse', raceId)] : [control('refuse', raceId), control('permit', raceId).then(() => control('recheck'))]);
    await control('recheck');
    await sleep(500);
    assert.ok(count(raceId) <= 1);
    const permitted = audit().filter(row => row.kind === 'admitted' && row.threadId === raceId);
    assert.ok(permitted.length <= 1);
    if (count(raceId)) assert.equal(permitted.length, 1);
    results.push({ scenario: `racing fence and activation ${i}`, threadId: raceId, providerInputs: count(raceId) });
  }

  if (realPi) {
    // Explicit opt-in: spends one real model turn using this machine's pi setup.
    const piId = spawn('Q1a optional real pi', 'pi');
    await held(piId);
    await control('bind', piId);
    await control('permit', piId);
    await control('recheck');
    const thread = await until(async () => JSON.parse(h.cli('thread', 'show', piId, '--json')), thread => ['idle', 'error'].includes(thread.status), 180_000);
    results.push({ scenario: 'real pi', threadId: piId, status: thread.status, note: 'Inspect retained thread log for provider acceptance; not synthetic input count' });
    await control('refuse', piId);
    h.cli('thread', 'stop', piId);
  }

  for (const row of inputs()) {
    const admission = audit().find(event => event.kind === 'admitted' && event.threadId === row.threadId);
    assert.ok(admission && admission.at <= row.at, 'R33 binding and permission precede provider input');
  }
  const report = { gate: 'Q1a', bb: '0.49.0', sdk: '0.6.132', syntheticProvider: 'docket-synthetic 0.1.0',
    piPlugin: JSON.parse(readFileSync(join(app, 'server', 'dist', 'builtin-plugins', 'provider-pi', 'package.json'), 'utf8')).version,
    node: process.version, platform: process.platform, arch: process.arch, realPi, results, providerInputs: inputs(), audit: audit() };
  writeFileSync(join(h.root, 'q1a.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(h.root, 'q1a.json'), results }, null, 2));
});
