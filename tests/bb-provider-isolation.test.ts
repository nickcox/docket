import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registrationReady, startIsolated, unrelated, type Plugin, type Provider, type StartupIO } from '../bb/harness/startup.ts';

// Fake subprocess/API boundary only: importing policy never loads the installed
// harness, spawns bb, runs provider commands or touches the filesystem.
function fixture() {
  const calls: string[] = [];
  const plugins: Plugin[] = [
    { id: 'provider-pi', enabled: true, status: 'running', providerIds: ['pi'] },
    ...unrelated.map(id => ({ id, enabled: true, status: 'running', providerIds: [id.slice('provider-'.length)] })),
    { id: 'provider-retry', enabled: true, status: 'running', providerIds: [] },
  ];
  const providers: Provider[] = plugins.flatMap(p => p.providerIds.map(id => ({ id, pluginId: p.id, pluginEnabled: true, enabled: true })));
  const io: StartupIO = {
    startServer: async () => { calls.push('server'); },
    waitRegistration: async () => { calls.push('registration-settled'); },
    installProbe: async () => {
      calls.push('install-probe');
      plugins.push({ id: 'docket-probe', enabled: true, status: 'running', providerIds: ['docket-synthetic'] });
      providers.push({ id: 'docket-synthetic', pluginId: 'docket-probe', pluginEnabled: true, enabled: true });
    },
    listPlugins: async () => { calls.push('plugins'); return { plugins }; },
    listProviders: async () => { calls.push('providers'); return providers; },
    disable: async id => {
      calls.push(`disable:${id}`);
      Object.assign(plugins.find(p => p.id === id)!, { enabled: false, status: 'disabled', providerIds: [] });
      for (const p of providers.filter(p => p.pluginId === id)) p.pluginEnabled = false;
    },
    connectDaemon: async () => { calls.push('enroll-and-connect'); },
    stopDaemon: async () => { calls.push('stop-daemon'); },
  };
  return { io, calls, plugins, providers };
}

test('R31/R33: server and registration precede selection; disable and verify precede enrollment/connection', async () => {
  const f = fixture();
  const selected = await startIsolated(f.io);
  assert.deepEqual(selected.map(p => p.id), ['provider-pi', 'docket-probe']);
  assert.deepEqual(f.calls, ['server', 'registration-settled', 'install-probe', ...unrelated.map(id => `disable:${id}`), 'providers', 'plugins', 'enroll-and-connect']);
});

test('R33: catalogue timeout/partial registrations are not readiness', () => {
  const f = fixture();
  assert.equal(registrationReady({ plugins: [] }, []), false);
  assert.equal(registrationReady({ plugins: f.plugins }, []), false);
  assert.equal(registrationReady({ plugins: f.plugins.slice(1) }, f.providers), false);
  assert.equal(registrationReady({ plugins: f.plugins }, f.providers), true);
  f.plugins.push({ id: 'late-plugin', enabled: true, status: 'starting', providerIds: [] });
  assert.equal(registrationReady({ plugins: f.plugins }, f.providers), false);
});

test('R33: registration must finish before any disable or daemon connection', async () => {
  const f = fixture();
  let release!: () => void;
  f.io.waitRegistration = () => new Promise<void>(resolve => { release = resolve; });
  const started = startIsolated(f.io);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['server']);
  release();
  await started;
  assert.equal(f.calls.at(-1), 'enroll-and-connect');
});

test('R33/R37: disable failure refuses enrollment and connection', async () => {
  const f = fixture();
  f.io.disable = async () => { throw new Error('CLI failed'); };
  await assert.rejects(startIsolated(f.io), /CLI failed/);
  assert.ok(!f.calls.includes('enroll-and-connect'));
});

test('R33: a successful disable response without effective disable refuses connection', async () => {
  const f = fixture();
  f.io.disable = async () => {};
  await assert.rejects(startIsolated(f.io), /not disabled/);
  assert.ok(!f.calls.includes('enroll-and-connect'));
});

test('R31/R33: unexpected enabled provider plugin or catalogue owner refuses connection', async () => {
  for (const catalogueOnly of [false, true]) {
    const f = fixture();
    f.plugins.push({ id: 'surprise', enabled: true, status: 'running', providerIds: catalogueOnly ? [] : ['unexpected'] });
    f.providers.push({ id: 'unexpected', pluginId: 'surprise', pluginEnabled: true, enabled: true });
    await assert.rejects(startIsolated(f.io), /Unexpected enabled provider/);
    assert.ok(!f.calls.includes('enroll-and-connect'));
  }
});

test('R31: absent Pi, incomplete registration and malformed inventories refuse connection', async () => {
  for (const fault of ['missing-pi', 'starting', 'invalid-plugins', 'invalid-providers']) {
    const f = fixture();
    if (fault === 'missing-pi') f.plugins.shift();
    if (fault === 'starting') f.plugins[0]!.status = 'starting';
    if (fault === 'invalid-plugins') f.io.listPlugins = async () => [];
    if (fault === 'invalid-providers') f.io.listProviders = async () => ({});
    await assert.rejects(startIsolated(f.io));
    assert.ok(!f.calls.includes('enroll-and-connect'), fault);
  }
});

test('R33/R37: restart stops daemon first and reverifies persisted selection before reconnect', async () => {
  const f = fixture();
  await startIsolated(f.io);
  f.calls.length = 0;
  await startIsolated(f.io, true);
  assert.deepEqual(f.calls, ['stop-daemon', 'server', 'registration-settled', 'providers', 'plugins', 'enroll-and-connect']);
  f.calls.length = 0;
  f.plugins.find(p => p.id === 'provider-claude-code')!.enabled = true;
  await assert.rejects(startIsolated(f.io, true), /not disabled/);
  assert.ok(!f.calls.includes('enroll-and-connect'));
  assert.ok(!f.calls.some(call => call.startsWith('disable:')));
});

test('R33: selection lookup errors refuse initial connection and restart reconnect', async () => {
  const f = fixture();
  await startIsolated(f.io);
  for (const restart of [true, false]) {
    f.calls.length = 0;
    f.io.listProviders = async () => { throw new Error('lookup unavailable'); };
    await assert.rejects(startIsolated(f.io, restart), /lookup unavailable/);
    assert.ok(!f.calls.includes('enroll-and-connect'));
  }
});
