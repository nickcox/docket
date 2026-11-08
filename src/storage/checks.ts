import type { JsonObject } from './database.ts';
import type { TaskActor } from './tasks.ts';
import type { TrustedChecks } from './reservations.ts';
import type { ExecutionProfile } from '../check-policy.ts';
import type { StoredRequest } from './requests.ts';
import type { ClaimIdentity } from './claims.ts';

export interface CheckRunInput {
  attemptId: string;
  commit: string;
  checks: TrustedChecks;
  profile: ExecutionProfile;
  caller: TaskActor;
  requestKey?: string;
}
export interface CheckAdmission {
  request: StoredRequest;
  execute: boolean;
  executor: ClaimIdentity | null;
}
export interface CheckRunResult extends JsonObject {
  status: 'passed' | 'failed' | 'uncertain';
  evidenceKey: string;
  commands: JsonObject[];
}
