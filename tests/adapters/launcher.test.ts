import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LauncherCapabilities } from '../../src/adapters/launcher.ts';
import { FakeLauncher } from '../helpers/fake-launcher.ts';

test('R31: fence enforcement is separate from terminal fence support and resource isolation', () => {
  const capabilities = new FakeLauncher().capabilities({});
  assert.equal(capabilities.terminalFence, true);
  assert.equal(capabilities.fenceEnforcement, 'enforced');
  assert.equal(Object.hasOwn(capabilities, 'resourceIsolation'), false);
  const bestEffort: LauncherCapabilities = { ...capabilities, fenceEnforcement: 'best_effort' };
  assert.equal(bestEffort.terminalFence, true);
  assert.equal(bestEffort.fenceEnforcement, 'best_effort');
});
