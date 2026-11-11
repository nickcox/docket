import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { controlRequest } from '../bb/harness/http.ts';
import { defer } from './helpers/cleanup.ts';

async function fixture(t: TestContext) {
  const child = fork(fileURLToPath(new URL('./fixtures/bb-control-server.ts', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  defer(t, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  });
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(typeof message.port, 'number');
  return `http://127.0.0.1:${message.port}`;
}

test('R31/R33/R37: control GETs and mutation use fresh connections across synchronous CLI blocking', { timeout: 15_000 }, async t => {
  const url = await fixture(t);
  const rows = [];
  for (const path of ['/api/v1/system/version', '/api/v1/plugins']) {
    const response = await controlRequest(url, path);
    assert.equal(response.ok, true);
    rows.push(JSON.parse(response.text));
  }
  // Stand in for execFileSync(plugin install). The separate HTTP process keeps
  // running and closes idle connections during this blocked client interval.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const response = await controlRequest(url, '/api/v1/plugins/provider-claude-code/disable', {});
  assert.equal(response.status, 200);
  rows.push(JSON.parse(response.text));
  assert.deepEqual(rows.map(row => row.method), ['GET', 'GET', 'POST']);
  assert.deepEqual(rows.map(row => row.path), ['/api/v1/system/version', '/api/v1/plugins', '/api/v1/plugins/provider-claude-code/disable']);
  assert.deepEqual(rows.map(row => row.connection), ['close', 'close', 'close']);
  assert.equal(new Set(rows.map(row => row.connectionId)).size, 3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const authenticated = await controlRequest(url, '/api/v1/plugins/docket-probe/http/control', { action: 'recheck' }, 5000, 'test-token');
  const row = JSON.parse(authenticated.text);
  assert.equal(row.authenticated, true);
  assert.equal(row.connection, 'close');
  assert.ok(!rows.some(other => other.connectionId === row.connectionId));
});

test('R31/R37: transport failure retains method, path and cause without body or mutation retry', { timeout: 15_000 }, async t => {
  const url = await fixture(t);
  await assert.rejects(controlRequest(url, '/reset', { token: 'secret-body-value' }, 5000, 'secret-header-value'), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Control request failed: POST /reset');
    assert.ok(error.cause instanceof TypeError);
    assert.ok(error.cause.cause);
    assert.ok(!error.message.includes(url));
    assert.ok(!error.message.includes('secret-body-value'));
    assert.ok(!error.message.includes('secret-header-value'));
    return true;
  });
  const response = await controlRequest(url, '/stats');
  assert.equal(JSON.parse(response.text).resets, 1);
  await assert.rejects(controlRequest(url, '/reset'), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Control request failed: GET /reset');
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
});
