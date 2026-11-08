import { isAbsolute, resolve } from 'node:path';
import type { JsonObject } from './database.ts';
import type { Task, TaskActor } from './tasks.ts';
import { fields, positive, text } from './claims.ts';

export interface CheckDefinition extends JsonObject {
  name: string;
  command: string[];
  timeoutMs: number;
  goalMs?: number;
}
/** Read and validated by trusted repository code, never from a worker workspace. */
export interface TrustedChecks extends JsonObject {
  sourceCommit: string;
  digest: string;
  fast: CheckDefinition[];
  full: CheckDefinition[];
}
export interface ReservationInput {
  requestKey: string;
  caller: TaskActor;
  taskId?: string;
  profile?: string;
  note?: string;
  sourceAttemptId?: string;
  startingCommit: string;
  checks: TrustedChecks;
  delivery: { kind: 'code' | 'report'; acceptance: 'review_or_integration'; requiredEvidence: string[]; requiredDeliverables: string[] };
  expectedDefinitionRevision?: number;
  expectedDecisionRevision?: number;
  expectedConfigRevision?: number;
  expectedConfigDigest?: string;
}
export interface Allocation extends JsonObject {
  leaseId: string;
  holder: JsonObject;
  path: string;
  pool: string;
  repository: JsonObject;
  outputRef: string;
  startingCommit: string;
}
export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  revision: number;
  executionOpen: boolean;
  phase: string;
  launchState: string;
  specification: JsonObject;
  allocation: Allocation | null;
  leaseState: string;
  outcome: string | null;
}
export interface Reservation {
  requestId: string;
  replayed: boolean;
  attempt: Attempt;
}
export interface ResolvedReservationConfig {
  revision: number;
  digest: string;
  baseBranch: string;
  poolRoot: string;
  maxAttempts: number;
  maxAttemptsPerTask: number;
  profile: JsonObject;
  profileName: string;
  profileSource: string;
  finalisation: JsonObject;
}

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected configuration object');
  return value as JsonObject;
}
function path(value: unknown): asserts value is string {
  text(value);
  if (!isAbsolute(value) || resolve(value) !== value) throw new TypeError('Expected absolute normalised path');
}
export function commit(value: unknown): void {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new TypeError('Expected exact commit');
}
export function reservationInput(value: ReservationInput): void {
  fields(value, ['requestKey', 'caller', 'taskId', 'profile', 'note', 'sourceAttemptId', 'startingCommit', 'checks', 'delivery',
    'expectedDefinitionRevision', 'expectedDecisionRevision', 'expectedConfigRevision', 'expectedConfigDigest']);
  text(value.requestKey);
  for (const name of ['taskId', 'profile', 'note', 'sourceAttemptId', 'expectedConfigDigest'] as const) {
    if (value[name] !== undefined) text(value[name]);
  }
  for (const revision of [value.expectedDefinitionRevision, value.expectedConfigRevision]) if (revision !== undefined) positive(revision);
  if (value.expectedDecisionRevision !== undefined && (!Number.isSafeInteger(value.expectedDecisionRevision) || value.expectedDecisionRevision < 0)) throw new TypeError('Invalid decision revision');
}
/** Only invoked for a new key: replay must not revalidate resolved repository evidence. */
export function reservationEvidence(value: ReservationInput): void {
  commit(value.startingCommit);
  fields(value.checks, ['sourceCommit', 'digest', 'fast', 'full']);
  commit(value.checks.sourceCommit); text(value.checks.digest);
  const names = new Set<string>();
  for (const set of [value.checks.fast, value.checks.full]) {
    if (!Array.isArray(set)) throw new TypeError('Expected check set');
    for (const check of set) {
      fields(check, ['name', 'command', 'timeoutMs', 'goalMs']);
      text(check.name); positive(check.timeoutMs);
      if (check.goalMs !== undefined) positive(check.goalMs);
      if (!Array.isArray(check.command) || check.command.length === 0) throw new TypeError('Expected check command');
      check.command.forEach(text);
      if (names.has(check.name)) throw new TypeError('Duplicate check name');
      names.add(check.name);
    }
  }
  fields(value.delivery, ['kind', 'acceptance', 'requiredEvidence', 'requiredDeliverables']);
  if (!['code', 'report'].includes(value.delivery.kind) || value.delivery.acceptance !== 'review_or_integration') throw new TypeError('Invalid delivery contract');
  for (const list of [value.delivery.requiredEvidence, value.delivery.requiredDeliverables]) {
    if (!Array.isArray(list)) throw new TypeError('Expected delivery requirements');
    list.forEach(text);
  }
}
export function resolveReservationConfig(payload: JsonObject, task: Task, explicitProfile?: string): ResolvedReservationConfig {
  positive(payload.revision); text(payload.digest);
  const config = record(payload.resolved);
  if (config.version !== 1) throw new TypeError('Unsupported configuration format');
  text(config.baseBranch);
  const limits = record(config.limits);
  positive(limits.maxAttempts); positive(limits.maxAttemptsPerTask);
  const workspace = record(config.workspace);
  fields(workspace, ['adapter', 'poolRoot']);
  if (workspace.adapter !== 'treehouse') throw new TypeError('Unsupported workspace adapter');
  path(workspace.poolRoot);
  const finalisation = record(config.finalisation);
  fields(finalisation, ['kind', 'targetBranch', 'globalFile', 'forbid']);
  if (!['manual', 'local-merge'].includes(String(finalisation.kind))) throw new TypeError('Invalid finalisation');
  text(finalisation.targetBranch);
  if (finalisation.globalFile !== null) path(finalisation.globalFile);
  if (!Array.isArray(finalisation.forbid)) throw new TypeError('Invalid finalisation restrictions');
  finalisation.forbid.forEach(text);
  const profiles = record(config.profiles), byKind = record(config.profileByKind);
  text(config.defaultProfile);
  for (const kind of ['code', 'report', 'review']) {
    text(byKind[kind]);
    if (!(String(byKind[kind]) in profiles)) throw new TypeError('Unknown kind profile');
  }
  if (!(config.defaultProfile in profiles)) throw new TypeError('Unknown default profile');
  const profileName = explicitProfile ?? task.profile ?? String(byKind[task.kind]);
  if (!Object.hasOwn(profiles, profileName)) throw new TypeError('Unknown execution profile');
  const profile = record(profiles[profileName]);
  fields(profile, ['launcher', 'provider', 'model', 'reasoning', 'runMs', 'maxCost', 'maxTokens', 'executionProfile']);
  if (!['bb', 'pi'].includes(String(profile.launcher))) throw new TypeError('Invalid launcher');
  text(profile.provider); text(profile.model); text(profile.executionProfile); positive(profile.runMs);
  if (profile.reasoning !== null) text(profile.reasoning);
  for (const key of ['maxCost', 'maxTokens']) {
    const limit = profile[key];
    if (limit !== null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || (key === 'maxTokens' && !Number.isSafeInteger(limit)))) throw new TypeError('Invalid profile budget');
  }
  return { revision: Number(payload.revision), digest: payload.digest, baseBranch: config.baseBranch,
    poolRoot: workspace.poolRoot, maxAttempts: Number(limits.maxAttempts), maxAttemptsPerTask: Number(limits.maxAttemptsPerTask),
    profile, profileName, profileSource: explicitProfile !== undefined ? 'dispatch' : task.profile !== null ? 'task' : `profileByKind.${task.kind}`, finalisation };
}
export function allocationInput(value: Allocation): void {
  fields(value, ['leaseId', 'holder', 'path', 'pool', 'repository', 'outputRef', 'startingCommit']);
  text(value.leaseId); path(value.path); path(value.pool); text(value.outputRef); commit(value.startingCommit);
  record(value.holder); record(value.repository);
}
