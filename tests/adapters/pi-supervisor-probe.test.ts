import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defer } from '../helpers/cleanup.ts';
import { createBinding } from '../../src/binding.ts';
import { PiSupervisor } from '../../src/adapters/pi-supervisor.ts';

// Explicitly opt in. Preparation checks the installed SDK and restrictions without a paid model request.
test('R35/A57: optional installed Pi SDK restricted-supervisor preparation probe', {
  skip: !process.env.DOCKET_REAL_PI_SUPERVISOR_SDK,
}, async t => {
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), 'docket-supervisor-probe-')));
  defer(t, () => rm(stateDirectory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const binding = createBinding({ kind: 'supervisor', id: sessionId, sessionId, objectiveId: 'probe' }, { context: 'probe' });
  const peer = new PiSupervisor({ stateDirectory, execution: { executable: process.execPath,
    sdkModule: process.env.DOCKET_REAL_PI_SUPERVISOR_SDK!, passEnvironment: [] },
    profile: { provider: process.env.PI_PROBE_PROVIDER ?? 'openai', model: process.env.PI_PROBE_MODEL ?? 'gpt-4o', reasoning: null } });
  defer(t, () => peer.stop().then(() => {}));
  await peer.prepare(sessionId, binding.catalogue.operations, async () => { throw new Error('No model requests during preparation'); });
});
