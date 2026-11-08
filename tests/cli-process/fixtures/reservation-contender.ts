import { once } from 'node:events';
import { dirname } from 'node:path';
import { Database, StorageError } from '../../../src/storage/database.ts';
import type { ReservationInput } from '../../../src/storage/reservations.ts';

const [path, encoded] = process.argv.slice(2);
if (!path || !encoded || !process.send) throw new Error('Missing reservation contender input');
using db = await Database.open(path, { location: { retainedRoot: dirname(path), recyclableRoots: [] }, readOnly: false, retryMs: 3000 });
const input = JSON.parse(encoded) as ReservationInput;
const go = once(process, 'message');
process.send('ready');
await go;
try {
  const result = await db.reserveAttempt(input);
  process.send({ result: 'reserved', id: result.attempt.id, taskId: result.attempt.taskId, replayed: result.replayed });
} catch (error) {
  if (!(error instanceof StorageError) || error.code !== 'conflict') throw error;
  process.send({ result: 'conflict' });
}
process.disconnect!();
