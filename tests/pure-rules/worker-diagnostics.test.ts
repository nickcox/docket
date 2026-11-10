import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { workerDiagnostics } from '../../src/worker-diagnostics.ts';

const state = resolve('state');
const preparation = (reference: Record<string, string>) => ({ result: { reference } });

test('R40/A58: diagnostic identity requires one recorded Pi directory strictly inside workers', () => {
  const directory = join(state, 'workers', 'unrelated-owner-name');
  const sessionFile = join(directory, 'sessions', 'arbitrary-session-name.jsonl');
  const reference = { launcher: 'pi', directory, sessionFile };
  assert.deepEqual(workerDiagnostics(state, [preparation(reference)]), { root: directory, transcript: sessionFile, reference });
  for (const records of [[], [preparation(reference), preparation(reference)],
    [preparation({ launcher: 'pi', sessionId: 'cannot-guess' })],
    [preparation({ ...reference, launcher: 'bb' })],
    ...[join(state, 'workers'), join(state, 'workers-other', 'owner'), join(state, 'attempts', 'id'),
      join(state, 'workers', '..', 'outside'), 'relative'].map(directory => [preparation({ ...reference, directory })]),
    [preparation({ ...reference, sessionFile: join(state, 'attempts', 'result.json') })],
    [preparation({ ...reference, sessionFile: join(directory, 'sessions') })]]) {
    assert.equal(workerDiagnostics(state, records), null);
  }
});
