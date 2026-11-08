import type { JsonObject } from './storage/database.ts';
import { Database } from './storage/database.ts';
import type { ClaimIdentity } from './storage/claims.ts';
import type { Allocation, Reservation, ReservationInput } from './storage/reservations.ts';
import type { GitRepository } from './adapters/repository.ts';

/** The workspace adapter must check all owner evidence before returning a confirmed allocation. */
export interface WorkspaceProvider {
  acquire(request: { requestId: string; input: JsonObject }): Promise<Allocation>;
}

/** Optional non-authoritative hints from an interrupted provider call. */
export class WorkspaceAcquisitionError extends Error {
  readonly evidence: JsonObject;
  constructor(message: string, evidence: JsonObject = {}) {
    super(message);
    this.name = 'WorkspaceAcquisitionError';
    this.evidence = evidence;
  }
}

/** Trusted dispatch entry point. A replay does not need to read a policy that may since have changed. */
export async function reserveWithTrustedChecks(db: Database, input: Omit<ReservationInput, 'checks'>,
  repository: Pick<GitRepository, 'readCheckPolicy'>): Promise<Reservation> {
  if (db.requests().some(request => request.requestKey === input.requestKey)) {
    return db.reserveAttempt({ ...input, checks: {} as ReservationInput['checks'] });
  }
  const config = db.checkConfiguration();
  const target = config.targetBranch.startsWith('refs/') ? config.targetBranch : `refs/heads/${config.targetBranch}`;
  const checks = await repository.readCheckPolicy(target, config.checks);
  return db.reserveAttempt({ ...input, checks, expectedConfigRevision: config.revision, expectedConfigDigest: config.digest });
}

/** No provider or filesystem work occurs under a SQLite transaction. Replays only inspect progress. */
export async function reserveAndAllocate(
  db: Database, input: ReservationInput, executor: ClaimIdentity, provider: WorkspaceProvider,
): Promise<Reservation> {
  const caller = { ...input.caller }, identity = { ...executor };
  const reservation = await db.reserveAttempt(input);
  if (reservation.replayed) return reservation;
  const { effect, claimed } = await db.beginWorkspaceAcquisition(reservation.attempt.id, reservation.requestId, identity, caller);
  if (!claimed) return { ...reservation, attempt: db.attempt(reservation.attempt.id) };
  let allocation: Allocation | undefined;
  try {
    allocation = await provider.acquire({ requestId: effect.id, input: effect.input });
    await db.recordAllocation(reservation.attempt.id, effect.id, identity, allocation);
  } catch (error) {
    // A thrown call, malformed response or lost local confirmation cannot prove that no lease exists.
    const evidence: JsonObject = { requestId: effect.id, request: effect.input,
      reason: error instanceof Error ? error.message : 'Workspace acquisition interrupted',
      ...(error instanceof WorkspaceAcquisitionError ? { provider: error.evidence } : {}),
      ...(allocation === undefined ? {} : { response: allocation }) };
    await db.recordUncertainAcquisition(reservation.attempt.id, effect.id, identity, evidence);
    throw error;
  }
  return { ...reservation, attempt: db.attempt(reservation.attempt.id) };
}
