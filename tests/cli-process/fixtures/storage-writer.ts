import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/storage/database.ts';

const [path, mode] = process.argv.slice(2);
if (!path || !mode) throw new Error('Expected database path and writer mode');
using database = await Database.open(path, { location: { retainedRoot: dirname(path), recyclableRoots: [] }, readOnly: false, retryMs: 1000 });
if (mode === 'commit') {
  await database.appendEvents([{ sourceKey: 'after-crash', kind: 'note.recorded', payloadVersion: 1,
    correlationId: 'crash-test', actor: { kind: 'person' }, occurredAt: new Date().toISOString(), payload: { text: 'recovered' } }]);
  process.send?.('committed');
  process.disconnect?.();
} else if (mode === 'hold') {
  // White-box fault injection into the real storage transaction, not a second implementation
  // of its locking. Raw SQL here only sets up the interrupted reservation scenario.
  const internal = database as unknown as { db: DatabaseSync; write: (change: () => void) => Promise<void> };
  await internal.write(() => {
    internal.db.exec(`
      INSERT INTO requests (id, request_key, category, operation, caller, fingerprint, input, target, created_at)
        VALUES ('request', 'reserve', 'command', 'reserve', '{}', 'digest', '{}', '{}', 'now');
      INSERT INTO attempts (id, task_id, number, phase, specification, output_ref, created_at)
        VALUES ('attempt', 'task', 1, 'reserved', '{"immutable":true}', 'output-ref', 'now');
      UPDATE tasks SET state = 'in_flight' WHERE id = 'task';
      INSERT INTO events (id, source_key, kind, payload_version, correlation_id, actor, occurred_at, recorded_at, payload)
        VALUES ('partial-event', 'partial-event', 'attempt.reserved', 1, 'crash-test', '{}', 'now', 'now', '{}');
    `);
    process.send?.('holding-write');
    // Deliberately stop inside the synchronous callback until the parent kills this process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
