import type { JsonObject } from './database.ts';
import type { TaskActor } from './tasks.ts';

export interface AcceptInput {
  requestKey: string;
  attemptId: string;
  candidateId: string;
  commit: string;
  caller: TaskActor;
  overrideReason?: string;
}
export interface ReturnInput {
  requestKey: string;
  attemptId: string;
  caller: TaskActor;
  noProcesses: { leaseId: string };
  discard?: { leaseId: string; confirmed: true; reason: string };
}
export interface FinalisationPlan extends JsonObject {
  kind: 'manual' | 'local-merge';
  target: string;
  expected: string;
  policyDigest: string;
}
