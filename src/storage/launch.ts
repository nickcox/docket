import type { JsonObject } from './database.ts';

/** Supplied by a trusted host binding, never by task input or thread metadata. */
export interface WorkerHost extends JsonObject {
  kind: 'host';
  id: string;
  generation: string;
}

/** Host identifiers are opaque to the core; paths and process IDs alone are not references. */
export interface WorkerReference extends JsonObject {
  launcher: string;
}

export function workerReference(value: unknown): asserts value is WorkerReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid worker reference');
  const reference = value as Record<string, unknown>;
  if (typeof reference.launcher !== 'string' || !reference.launcher.trim()
    || Object.keys(reference).length < 2) throw new TypeError('Worker reference requires launcher and host identifiers');
  for (const [key, identifier] of Object.entries(reference)) {
    if (!key.trim() || typeof identifier !== 'string' || !identifier.trim()) throw new TypeError('Invalid worker identifier');
  }
}

export type LaunchDecision = { state: 'permitted' | 'fenced'; changed: boolean; effectId: string | null };
export type InitialPromptAdmission =
  | { kind: 'admitted'; effectId: string }
  | { kind: 'pending' | 'fenced' | 'already_admitted' };

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function workerHost(value: unknown): asserts value is WorkerHost {
  if (!fields(value, ['kind', 'id', 'generation']) || value.kind !== 'host'
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.generation !== 'string' || !value.generation.trim()) {
    throw new TypeError('Invalid worker host binding');
  }
}
