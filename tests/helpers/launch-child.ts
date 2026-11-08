import { Database, StorageError } from '../../src/storage/database.ts';

const [path, root, attemptId, claimId] = process.argv.slice(2) as [string, string, string, string];
using db = await Database.open(path, { location: { retainedRoot: root, recyclableRoots: [] }, readOnly: false, retryMs: 1000 });
const host = { kind: 'host' as const, id: 'backend', generation: 'generation-1' };
process.send!({ ready: true });
process.once('message', async () => {
  try {
    const decision = await db.decideWorkerLaunch(attemptId, claimId, 'permit', host);
    const admission = await db.claimWorkerActivation(attemptId, db.request(decision.effectId!).target!.reference as { launcher: string }, host);
    process.send!({ permitted: true, admitted: admission.kind === 'admitted' });
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== 'conflict') throw error;
    process.send!({ permitted: false, admitted: false });
  } finally {
    process.disconnect!();
  }
});
// Keep the connection open through the resumed callback, then close on process exit.
await new Promise<void>(resolve => process.once('disconnect', resolve));
