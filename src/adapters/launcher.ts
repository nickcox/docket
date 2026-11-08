import type { JsonObject } from '../storage/database.ts';
import type { WorkerReference } from '../storage/launch.ts';
import type { Allocation } from '../storage/reservations.ts';
import type { Result } from './command.ts';

export interface WorkerBinding extends JsonObject {
  databaseId: string;
  contextId: string;
  taskId: string;
  attemptId: string;
  specification: JsonObject;
  allocation: Allocation;
  sessionId: string;
  profileDigest: string;
  owner: { claimId: string; generation: string };
}
export interface LauncherCapabilities {
  preparation: 'non_acting' | 'protected' | 'unsupported';
  admission: boolean;
  activeSteering: boolean;
  afterTurnMessage: boolean;
  stopTurn: boolean;
  terminalFence: boolean;
  usageMetrics: readonly string[];
  resourceIsolation: readonly string[];
  observationSources: readonly string[];
}
export type WorkerObservation =
  | { status: 'known'; sourceId: string; sequence: number; worker: 'prepared' | 'active' | 'stopped'; turn: 'idle' | 'running' | 'ended'; terminal: boolean }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string };
export type Usage = { status: 'reported'; sourceId: string; sequence: number; metrics: Record<string, number> }
  | { status: 'unknown' | 'unsupported'; reason: string };
export type MessageMode = 'active_steering' | 'after_turn';

/** Each effect method makes one call only. An uncertain reply never authorises a retry. */
export interface Launcher {
  capabilities(profile: JsonObject): LauncherCapabilities;
  prepare(binding: WorkerBinding, effectId: string): Promise<Result<WorkerReference>>;
  activate(reference: WorkerReference, storedInput: JsonObject, effectId: string, claimGeneration: string): Promise<Result<JsonObject>>;
  inspect(reference: WorkerReference): Promise<WorkerObservation>;
  deliver(reference: WorkerReference, message: string, mode: MessageMode, effectId: string): Promise<Result<JsonObject>>;
  stop(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>>;
  fence(reference: WorkerReference, effectId: string): Promise<Result<JsonObject>>;
  usage(reference: WorkerReference): Promise<Usage>;
  result(reference: WorkerReference): Promise<Result<{ transport: string; reference: JsonObject }>>;
}
