import type { JsonObject } from './database.ts';
import { claimIdentity, fields, text } from './claims.ts';
import type { ClaimIdentity } from './claims.ts';

export interface CommandInput {
  requestKey: string;
  operation: string;
  caller: JsonObject;
  fingerprint: string;
  input: JsonObject;
}
export interface EffectTarget {
  kind: 'workspace' | 'worker' | 'answer' | 'checks' | 'repository' | 'diagnostics';
  reference: JsonObject;
}
export interface EffectInput extends CommandInput {
  parentId: string;
  executor: ClaimIdentity;
  target: EffectTarget;
  attemptId?: string;
  objectiveId?: string;
}
export type EffectState = 'pending' | 'claimed' | 'succeeded' | 'rejected' | 'withdrawn' | 'uncertain';
export type EffectOutcome = 'succeeded' | 'rejected' | 'uncertain';
export interface StoredRequest extends CommandInput {
  id: string;
  category: 'command' | 'effect';
  parentId: string | null;
  attemptId: string | null;
  objectiveId: string | null;
  target: EffectTarget | null;
  state: EffectState;
  claimId: string | null;
  revision: number;
  createdAt: string;
  claimedAt: string | null;
  result: JsonObject | null;
}

export function commandInput(value: CommandInput, effect = false): void {
  fields(value, ['requestKey', 'operation', 'caller', 'fingerprint', 'input',
    ...(effect ? ['parentId', 'executor', 'target', 'attemptId', 'objectiveId'] : [])]);
  text(value.requestKey); text(value.operation); text(value.fingerprint);
}
export function effectInput(value: EffectInput): void {
  commandInput(value, true);
  text(value.parentId); claimIdentity(value.executor);
  for (const id of [value.attemptId, value.objectiveId]) if (id !== undefined) text(id);
  fields(value.target, ['kind', 'reference']);
  if (!['workspace', 'worker', 'answer', 'checks', 'repository', 'diagnostics'].includes(value.target.kind)) {
    throw new TypeError('Invalid effect target kind');
  }
}
