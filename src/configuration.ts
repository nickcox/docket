import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JsonObject } from './storage/database.ts';

export class ConfigurationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
    this.name = 'ConfigurationError';
  }
}

type ObjectValue = Record<string, unknown>;
function refuse(field: string, message = 'Invalid value'): never { throw new ConfigurationError(field, message); }
function object(value: unknown, field: string, keys?: readonly string[]): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(field, 'Expected an object');
  const result = value as ObjectValue;
  if (keys) {
    for (const key of Object.keys(result)) if (!keys.includes(key)) refuse(`${field}.${key}`, 'Unknown field');
    for (const key of keys) if (!Object.hasOwn(result, key)) refuse(`${field}.${key}`, 'Required field');
  }
  return result;
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 65536 || /[\0\r\n]/u.test(value)) refuse(field, 'Expected nonblank single-line text');
}
function choice(value: unknown, field: string, choices: readonly string[]): void {
  if (typeof value !== 'string' || !choices.includes(value)) refuse(field, 'Unsupported value');
}
function integer(value: unknown, field: string, zero = false, maximum = 2147483647): void {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1) || Number(value) > maximum) refuse(field, `Expected an integer from ${zero ? 0 : 1} to ${maximum}`);
}
function strings(value: unknown, field: string, nonempty = false): void {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) refuse(field, 'Expected an array');
  value.forEach((item, index) => text(item, `${field}[${index}]`));
}

export function inside(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Validate even absent paths using their closest existing ancestor. Never resolve links silently. */
export async function canonicalPath(value: unknown, field: string): Promise<string> {
  text(value, field);
  if (!isAbsolute(value) || resolve(value) !== value) refuse(field, 'Path must be absolute and canonical');
  let ancestor = value;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || await realpath(ancestor) !== ancestor) refuse(field, 'Path must be canonical, without symbolic links');
      if (ancestor !== value && !info.isDirectory()) refuse(field, 'Parent must be a directory');
      return value;
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) refuse(field, 'Cannot validate path');
      const parent = dirname(ancestor);
      if (parent === ancestor) refuse(field, 'No existing parent');
      ancestor = parent;
    }
  }
}

/** JSON.parse accepts duplicate members; configuration must not hide fields by overwriting them. */
export function strictJson(source: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { refuse('$', 'Invalid JSON'); }
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu)!;
  let index = 0;
  function visit(field: string, depth: number): void {
    if (depth > 64) refuse(field, 'JSON nesting exceeds 64 levels');
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]!) as string;
        if (keys.has(key)) refuse(`${field}.${key}`, 'Duplicate field');
        keys.add(key);
        index++; // colon
        visit(`${field}.${key}`, depth + 1);
        if (tokens[index] !== ',') break;
        index++;
      }
      index++; // closing brace
    } else if (token === '[') {
      let position = 0;
      while (tokens[index] !== ']') {
        visit(`${field}[${position++}]`, depth + 1);
        if (tokens[index] !== ',') break;
        index++;
      }
      index++; // closing bracket
    }
  }
  visit('$', 0);
  return parsed;
}

export interface Configuration extends JsonObject {
  version: 1;
  contextId: string;
  databasePath: string;
  stateDirectory: string;
  repository: string;
  baseBranch: string;
  workspace: { adapter: 'treehouse'; poolRoot: string };
}
export interface ResolvedConfiguration {
  resolved: Configuration;
  digest: string;
  revision: number;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as ObjectValue)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function configurationPaths(contextId: string, home: string, stateDirectory = join(home, '.docket', contextId)) {
  if (!/^[A-Za-z0-9._-]+$/u.test(contextId) || contextId === '.' || contextId === '..') refuse('$.contextId');
  return { stateDirectory, databasePath: join(stateDirectory, 'docket.db'), workspace: { adapter: 'treehouse' as const, poolRoot: join(stateDirectory, 'pool') } };
}

/** No environment expansion, implicit credentials or policy defaults enter the digest. */
export async function parseConfiguration(textValue: string, recyclableRoots: readonly string[] = []): Promise<ResolvedConfiguration> {
  const config = object(strictJson(textValue), '$', ['version', 'contextId', 'databasePath', 'stateDirectory', 'repository', 'baseBranch', 'workspace', 'limits', 'profiles', 'defaultProfile', 'profileByKind', 'finalisation', 'checks', 'supervisor', 'keepAwake']);
  if (config.version !== 1) refuse('$.version', 'Expected configuration format 1');
  text(config.contextId, '$.contextId');
  configurationPaths(config.contextId, '/');
  text(config.baseBranch, '$.baseBranch');
  for (const key of ['databasePath', 'stateDirectory', 'repository']) await canonicalPath(config[key], `$.${key}`);
  const workspace = object(config.workspace, '$.workspace', ['adapter', 'poolRoot']);
  choice(workspace.adapter, '$.workspace.adapter', ['treehouse']);
  await canonicalPath(workspace.poolRoot, '$.workspace.poolRoot');
  if (inside(String(config.stateDirectory), String(config.databasePath))) refuse('$.databasePath', 'Database file must not contain the state directory');
  if (inside(String(config.stateDirectory), String(workspace.poolRoot))) refuse('$.stateDirectory', 'State directory must be outside the workspace pool');
  if (inside(String(config.databasePath), String(workspace.poolRoot))) refuse('$.databasePath', 'Database must be outside the workspace pool');
  if (inside(String(workspace.poolRoot), String(config.databasePath))) refuse('$.workspace.poolRoot', 'Pool must not be below a database file');
  for (const root of recyclableRoots) {
    await canonicalPath(root, '$policy.recyclableRoots');
    for (const [field, value] of [['$.stateDirectory', config.stateDirectory], ['$.databasePath', config.databasePath], ['$.workspace.poolRoot', workspace.poolRoot]]) {
      if (inside(String(value), root)) refuse(String(field), 'Path is inside a recyclable root');
    }
  }
  const limits = object(config.limits, '$.limits', ['maxAttempts', 'maxAttemptsPerTask', 'maxConcurrentFullChecks']);
  for (const [key, value] of Object.entries(limits)) integer(value, `$.limits.${key}`);
  const profiles = object(config.profiles, '$.profiles');
  if (!Object.keys(profiles).length) refuse('$.profiles', 'At least one profile is required');
  for (const [name, value] of Object.entries(profiles)) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name)) refuse('$.profiles', 'Invalid profile name');
    const field = `$.profiles.${name}`;
    const profile = object(value, field, ['launcher', 'provider', 'model', 'reasoning', 'runMs', 'maxCost', 'maxTokens', 'executionProfile']);
    choice(profile.launcher, `${field}.launcher`, ['bb', 'pi']);
    for (const key of ['provider', 'model', 'executionProfile']) text(profile[key], `${field}.${key}`);
    if (profile.reasoning !== null) text(profile.reasoning, `${field}.reasoning`);
    integer(profile.runMs, `${field}.runMs`);
    if (profile.maxCost !== null && (typeof profile.maxCost !== 'number' || !Number.isFinite(profile.maxCost) || profile.maxCost < 0)) refuse(`${field}.maxCost`);
    if (profile.maxTokens !== null) integer(profile.maxTokens, `${field}.maxTokens`, true, Number.MAX_SAFE_INTEGER);
  }
  function profileName(value: unknown, field: string) {
    text(value, field);
    if (!Object.hasOwn(profiles, value)) refuse(field, 'Profile is not configured');
  }
  profileName(config.defaultProfile, '$.defaultProfile');
  const byKind = object(config.profileByKind, '$.profileByKind', ['code', 'report', 'review']);
  for (const [key, value] of Object.entries(byKind)) profileName(value, `$.profileByKind.${key}`);
  const finalisation = object(config.finalisation, '$.finalisation', ['kind', 'targetBranch', 'globalFile', 'forbid']);
  choice(finalisation.kind, '$.finalisation.kind', ['manual', 'local-merge']);
  text(finalisation.targetBranch, '$.finalisation.targetBranch');
  if (finalisation.globalFile !== null) await canonicalPath(finalisation.globalFile, '$.finalisation.globalFile');
  strings(finalisation.forbid, '$.finalisation.forbid');
  const checks = object(config.checks, '$.checks', ['executionProfile', 'fast', 'full']);
  text(checks.executionProfile, '$.checks.executionProfile');
  const names = new Set<string>();
  for (const kind of ['fast', 'full']) {
    const list = checks[kind];
    if (!Array.isArray(list)) refuse(`$.checks.${kind}`, 'Expected an array');
    list.forEach((value, index) => {
      const field = `$.checks.${kind}[${index}]`;
      const check = object(value, field);
      const keys = ['name', 'command', 'timeoutMs'];
      object(value, field, Object.hasOwn(check, 'goalMs') ? [...keys, 'goalMs'] : keys);
      text(check.name, `${field}.name`);
      if (names.has(check.name)) refuse(`${field}.name`, 'Check names must be unique');
      names.add(check.name);
      strings(check.command, `${field}.command`, true);
      integer(check.timeoutMs, `${field}.timeoutMs`);
      if (Object.hasOwn(check, 'goalMs')) integer(check.goalMs, `${field}.goalMs`);
    });
  }
  const supervisor = object(config.supervisor, '$.supervisor', ['defaultHost', 'piExecutionProfile']);
  choice(supervisor.defaultHost, '$.supervisor.defaultHost', ['bb', 'pi']);
  text(supervisor.piExecutionProfile, '$.supervisor.piExecutionProfile');
  if (typeof config.keepAwake !== 'boolean') refuse('$.keepAwake');
  const resolved = config as Configuration;
  return { resolved, digest: `sha256:${createHash('sha256').update(canonicalJson(resolved)).digest('hex')}`, revision: 1 };
}
