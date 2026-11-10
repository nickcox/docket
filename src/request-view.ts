import { redactDiagnostics } from './adapters/checks.ts';
import type { Database, JsonObject } from './storage/database.ts';
import type { StoredRequest } from './storage/requests.ts';

const privateField = /(?:secret|password|credential|token|api[_-]?key|private[_-]?key|authorization|cookie|^(?:env|environment|passEnvironment)$)/iu;
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnostics(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, privateField.test(key) ? '[redacted]' : redact(item)]));
  return value;
}

/** Redact before truncating so a diagnostic limit cannot expose part of a credential. */
function bounded(value: JsonObject | null, bytes: number): JsonObject | null {
  if (value === null) return null;
  const safe = redact(value) as JsonObject;
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= bytes) return safe;
  // Each UTF-16 code unit needs at most six JSON bytes after escaping.
  return { truncated: true, summary: encoded.slice(0, Math.floor((bytes - 64) / 6)) };
}

function identity(request: StoredRequest) {
  return { id: request.id, requestId: request.requestKey, operation: request.operation, state: request.state };
}

export function requestView(db: Database, request: StoredRequest): Record<string, unknown> {
  const effects = db.requests().filter(effect => effect.parentId === request.id);
  const interruptedCheck = request.operation === 'checks.run' && ['claimed', 'uncertain'].includes(request.state);
  const resolution = request.operation === 'checks.run'
    ? db.events().find(event => event.kind === 'checks.resolved' && event.requestId === request.id) : undefined;
  return { ...identity(request), category: request.category,
    resolution: resolution ? bounded(resolution.payload, 8192) : null,
    nextAction: interruptedCheck ? { operation: 'checks.resolve', args: { checkRequestId: request.id,
      confirmStopped: false, evidence: 'Inspect the stopped check owner.', dryRun: true },
      description: 'A person must confirm the owner has stopped before resolving this exact check run.' } : null,
    caller: bounded(request.caller, 4096), attemptId: request.attemptId, objectiveId: request.objectiveId,
    parent: request.parentId === null ? null : identity(db.request(request.parentId)),
    target: request.target === null ? null : { kind: request.target.kind, reference: bounded(request.target.reference, 8192) },
    input: bounded(request.input, 128 * 1024), result: bounded(request.result, 32 * 1024),
    effects: effects.slice(0, 20).map(identity), effectsTotal: effects.length };
}
