import { canonicalJson } from '../configuration.ts';
import type { Allocation as StoredAllocation } from '../storage/reservations.ts';
import type { ReturnWorkspace } from '../completion.ts';
import type { TreehouseWorkspace, Allocation } from './workspace.ts';
import { confirmed, rejected, uncertain } from './command.ts';
import type { Result } from './command.ts';

/** Translate the stored domain identity without weakening Treehouse's full allocation checks. */
export function completionWorkspace(workspace: TreehouseWorkspace): ReturnWorkspace {
  async function find(expected: StoredAllocation): Promise<Result<Allocation>> {
    if (workspace.options.poolRoot !== expected.pool || typeof expected.repository.path !== 'string') return rejected('Stored pool or repository identity is invalid');
    const identity = await workspace.options.repository.identity(expected.repository.path);
    if (identity.status !== 'confirmed') return identity;
    const receipt = await workspace.recordedAllocation(expected.leaseId);
    if (receipt.status !== 'confirmed') return receipt;
    const lease = receipt.value;
    let holder: unknown;
    try { holder = JSON.parse(lease.holder); }
    catch { return uncertain('Lease holder cannot be matched to the stored identity'); }
    if (canonicalJson(holder) !== canonicalJson(expected.holder) || lease.path !== expected.path
      || `refs/heads/${lease.branch}` !== expected.outputRef || lease.startingCommit !== expected.startingCommit
      || lease.repository !== identity.value) return rejected('Live allocation differs from the stored allocation');
    return confirmed(lease);
  }
  return {
    inspect: async (expected, detachedCommit) => {
      const found = await find(expected);
      if (found.status !== 'confirmed') return found;
      const inspected = await workspace.inspect(found.value, detachedCommit);
      if (inspected.status !== 'confirmed') return inspected;
      return confirmed({ state: inspected.value.state });
    },
    returnLease: async (expected, request) => {
      const found = await find(expected);
      if (found.status !== 'confirmed') return found;
      return workspace.returnLease(found.value, request);
    },
  };
}
