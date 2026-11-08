import type { JsonObject } from './database.ts';

export type ClaimRole = 'worker_owner' | 'supervisor' | 'check_executor' | 'maintenance';
export interface ClaimInput {
  resourceKey: string;
  role: ClaimRole;
  attemptId?: string;
  objectiveId?: string;
  generation: string;
  ownerRef: JsonObject;
  schemaFamily: number;
  schemaVersion: number;
  configRevision: number;
  heartbeatAt: string;
}
export interface Claim extends ClaimInput {
  id: string;
  revision: number;
  releasedAt: string | null;
  releaseEvidence: JsonObject | null;
}
export interface ClaimIdentity { claimId: string; generation: string }
export type HeartbeatStatus = 'fresh' | 'stale' | 'future_dated' | 'unreadable';

/** Time is diagnostic only. This rule never releases or transfers ownership. */
export function heartbeatStatus(heartbeatAt: unknown, now: number): HeartbeatStatus {
  if (!Number.isFinite(now)) throw new TypeError('Expected a finite observation time');
  const time = typeof heartbeatAt === 'string' && heartbeatAt.trim() ? Date.parse(heartbeatAt) : NaN;
  if (!Number.isFinite(time)) return 'unreadable';
  const age = now - time;
  return age < 0 ? 'future_dated' : age < 30_000 ? 'fresh' : 'stale';
}

export function fields(value: object, keys: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Unknown input field');
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected nonblank text');
}
export function positive(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError('Expected a positive integer');
}
export function timestamp(value: unknown): asserts value is string {
  text(value);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError('Expected a readable time');
}
export function claimIdentity(value: ClaimIdentity): void {
  fields(value, ['claimId', 'generation']);
  text(value.claimId); text(value.generation);
}
export function claimInput(value: ClaimInput): void {
  fields(value, ['resourceKey', 'role', 'attemptId', 'objectiveId', 'generation', 'ownerRef',
    'schemaFamily', 'schemaVersion', 'configRevision', 'heartbeatAt']);
  text(value.resourceKey); text(value.generation); timestamp(value.heartbeatAt);
  if (!['worker_owner', 'supervisor', 'check_executor', 'maintenance'].includes(value.role)) throw new TypeError('Invalid claim role');
  for (const id of [value.attemptId, value.objectiveId]) if (id !== undefined) text(id);
  positive(value.schemaFamily); positive(value.schemaVersion); positive(value.configRevision);
  if (value.role === 'worker_owner' && (!value.attemptId || value.resourceKey !== `worker:${value.attemptId}`)) {
    throw new TypeError('A worker owner must name its attempt resource');
  }
}

export type AdmissionBlocker =
  | { kind: 'claim'; claimId: string; resourceKey: string; reason: Exclude<HeartbeatStatus, 'fresh'> }
  | { kind: 'effect'; requestId: string; reason: 'claimed' | 'uncertain' };
