import { createHash } from 'node:crypto';
import { canonicalJson, strictJson } from './configuration.ts';
import type { JsonObject } from './storage/database.ts';
import type { CheckDefinition, TrustedChecks } from './storage/reservations.ts';

export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface ExecutionProfile extends JsonObject {
  id: string;
  tools: JsonObject;
  dependencies: JsonObject;
  ignoredGeneratedPaths?: string[];
}
export interface CheckPolicy extends TrustedChecks {
  present: boolean;
  sourceDigest: string | null;
  executionProfile: string;
}
export interface ContextChecks extends JsonObject {
  executionProfile: string;
  fast: CheckDefinition[];
  full: CheckDefinition[];
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Malformed check policy');
  return value as Record<string, unknown>;
}
export function definitions(value: unknown): CheckDefinition[] {
  if (!Array.isArray(value)) throw new TypeError('Expected check definitions');
  return value.map(item => {
    const check = object(item, ['name', 'command', 'timeoutMs', 'goalMs']);
    if (typeof check.name !== 'string' || !check.name.trim() || /[\0\r\n]/u.test(check.name)
      || !Array.isArray(check.command) || !check.command.length
      || check.command.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !check.command[0] || !Number.isSafeInteger(check.timeoutMs) || Number(check.timeoutMs) < 1
      || Number(check.timeoutMs) > 2147483647
      || (check.goalMs !== undefined && (!Number.isSafeInteger(check.goalMs) || Number(check.goalMs) < 1))) {
      throw new TypeError('Malformed check definition');
    }
    return structuredClone(check) as CheckDefinition;
  });
}

/** Null is a proven absent file, not a failed read. Content, rather than the source commit, identifies policy. */
export function parseCheckPolicy(sourceCommit: string, content: string | null, context: ContextChecks): CheckPolicy {
  object(context, ['executionProfile', 'fast', 'full']);
  if (typeof context.executionProfile !== 'string' || !context.executionProfile.trim()) throw new TypeError('Expected execution profile');
  const policy = content === null ? { version: 1, fast: [], full: [] } : object(strictJson(content), ['version', 'fast', 'full']);
  if (policy.version !== 1) throw new TypeError('Unsupported check policy version');
  const fast = [...definitions(policy.fast), ...definitions(context.fast)];
  const full = [...definitions(policy.full), ...definitions(context.full)];
  if (new Set([...fast, ...full].map(check => check.name)).size !== fast.length + full.length) throw new TypeError('Duplicate check name');
  const sourceDigest = content === null ? null : createHash('sha256').update(content).digest('hex');
  return { sourceCommit, sourceDigest, present: content !== null, digest: digest({ sourceDigest, context }), executionProfile: context.executionProfile, fast, full };
}

/** Preserve recorded requirements when the current target weakens or replaces them. */
export function mandatoryChecks(recorded: TrustedChecks, current: TrustedChecks): TrustedChecks {
  const seen = new Set<string>();
  const unique = (checks: CheckDefinition[]) => checks.filter(check => {
    const key = digest(check);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { sourceCommit: current.sourceCommit, digest: digest([recorded.digest, current.digest]),
    fast: unique([...recorded.fast, ...current.fast]), full: unique([...recorded.full, ...current.full]) };
}
export function checkEvidenceKey(repository: JsonObject, candidate: string, criteria: string[], checks: TrustedChecks, profile: ExecutionProfile): string {
  object(profile, ['id', 'tools', 'dependencies', 'ignoredGeneratedPaths']);
  if (profile.ignoredGeneratedPaths !== undefined && (!Array.isArray(profile.ignoredGeneratedPaths)
    || profile.ignoredGeneratedPaths.some(path => typeof path !== 'string' || !path || path.startsWith('/')
      || path.includes('\\') || path.split('/').includes('..')))) throw new TypeError('Invalid ignored generated paths');
  if (typeof profile.id !== 'string' || !profile.id.trim() || !profile.tools || !profile.dependencies
    || Array.isArray(profile.tools) || Array.isArray(profile.dependencies)
    || typeof profile.tools !== 'object' || typeof profile.dependencies !== 'object') throw new TypeError('Expected declared profile identity and versions');
  const checkDefinitions = { fast: definitions(checks.fast), full: definitions(checks.full) };
  return digest({ repository, candidate, criteriaDigest: digest(criteria), definitions: checkDefinitions, definitionsDigest: digest(checkDefinitions),
    policyDigest: checks.digest, executionProfile: profile });
}
