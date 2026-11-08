import { dirname } from 'node:path';
import { applicationId, Database, StorageError } from '../../../src/storage/database.ts';

const path = process.argv[2]!;
using db = await Database.open(path, { location: { retainedRoot: dirname(path), recyclableRoots: [] }, readOnly: false, retryMs: 2000 });
process.once('message', async message => {
  try {
    if (message !== 'go') throw new Error('Expected race barrier');
    const [claim] = await db.registerClaims([{ resourceKey: 'contested', role: 'maintenance', generation: process.argv[3]!,
      ownerRef: { process: process.pid }, schemaFamily: applicationId, schemaVersion: 1, configRevision: 1,
      heartbeatAt: new Date().toISOString() }], { kind: 'process', id: String(process.pid) });
    process.send!({ result: 'registered', claimId: claim!.id });
  } catch (error) {
    if (error instanceof StorageError && error.code === 'conflict') process.send!({ result: 'conflict' });
    else { console.error(error); process.exitCode = 1; }
  } finally {
    db.close();
    process.disconnect!();
  }
});
process.send!('ready');
// Keep the connection open until the single explicit race command has completed.
await new Promise<void>(resolve => process.once('disconnect', resolve));
