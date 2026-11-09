import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalPath, ConfigurationError, inside, parseConfiguration, strictJson } from './configuration.ts';
import type { ResolvedConfiguration } from './configuration.ts';
import { Database, StorageError } from './storage/database.ts';
import type { TaskActor } from './storage/tasks.ts';
import { CommandFailure } from './response.ts';
import { nextAction } from './next-action.ts';
import { step } from './plans.ts';

export class ContextError extends Error {
  readonly code: 'context_registered' | 'context_mismatch' | 'config_changed' | 'storage_busy' | 'not_initialised';
  readonly data: Record<string, unknown>;
  constructor(code: ContextError['code'], message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'ContextError';
  }
}

export interface ContextOptions {
  /** Trusted host policy. Hosts must supply their complete inventory, including other pools. */
  recyclableRoots?: readonly string[];
  home?: string;
}
export type ContextSelector = { config: string; context?: never } | { context: string; config?: never };

function registryPath(options: ContextOptions): string { return join(options.home ?? homedir(), '.config', 'docket', 'contexts.json'); }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

async function registry(path: string): Promise<Record<string, string>> {
  await canonicalPath(path, '$registry');
  let value: unknown;
  try { value = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))); }
  catch (error) {
    if (missing(error)) return {};
    throw new ConfigurationError('$registry', 'Cannot read a valid context registry');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError('$registry', 'Expected a name-to-file object');
  for (const [name, file] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') throw new ConfigurationError('$registry', 'Invalid context name');
    await canonicalPath(file, '$registry.config');
  }
  return value as Record<string, string>;
}

export async function resolveContext(selector: ContextSelector, options: ContextOptions = {}): Promise<ResolvedConfiguration & { file: string }> {
  let file: string;
  if (typeof selector.config === 'string' && selector.context === undefined) file = resolve(selector.config);
  else if (typeof selector.context === 'string' && selector.config === undefined) {
    const entries = await registry(registryPath(options));
    if (!Object.hasOwn(entries, selector.context)) throw new ContextError('not_initialised', 'Context name is not registered');
    file = entries[selector.context]!;
  } else throw new ConfigurationError('$selector', 'Select exactly one of --config and --context');
  await canonicalPath(file, '$config');
  let source: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw new ConfigurationError('$config', 'Configuration must be a regular file without hard links');
    source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('$config', 'Cannot read configuration');
  }
  const configuration = await parseConfiguration(source, options.recyclableRoots);
  if (selector.context !== undefined && configuration.resolved.contextId !== selector.context) throw new ContextError('context_mismatch', 'Registry name and configuration contextId differ');
  return { ...configuration, file };
}

/** Keep this file in place: SQLite locks its inode and releases it on process exit. */
async function lockRegistry(path: string): Promise<DatabaseSync> {
  await canonicalPath(path, '$registry.lock');
  const file = await open(path, 'a', 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new ConfigurationError('$registry.lock', 'Expected a regular file without hard links');
  } finally { await file.close(); }
  const lock = new DatabaseSync(path, { timeout: 0 });
  try {
    const deadline = performance.now() + 5000;
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); return lock; }
      catch (error) {
        if (!(error instanceof Error) || !('errcode' in error) || ![5, 6].includes(Number(error.errcode) & 0xff)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ContextError('storage_busy', 'Context registry remained locked after 5000ms; retry the initialisation');
        await sleep(Math.min(20, remaining));
      }
    }
  } catch (error) { lock.close(); throw error; }
}

/** The registry lock serialises initialisers across names, including path collision checks. */
export async function initialiseContext(selector: ContextSelector, options: ContextOptions & { caller: TaskActor }): Promise<Record<string, unknown>> {
  const configuration = await resolveContext(selector, options);
  const { resolved: config, digest, revision, file } = configuration;
  const path = registryPath(options);
  await canonicalPath(dirname(path), '$registry');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await lockRegistry(`${path}.lock.sqlite`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const entries = await registry(path);
    if (Object.hasOwn(entries, config.contextId)) throw new ContextError('context_registered', 'Context name is already registered');
    for (const existingFile of Object.values(entries)) {
      const registered = await openContext({ config: existingFile }, options);
      using registeredDatabase = registered.database;
      const existing = registered.configuration.resolved;
      const currentRoots = [config.stateDirectory, config.databasePath, config.workspace.poolRoot];
      const existingRoots = [existing.stateDirectory, existing.databasePath, existing.workspace.poolRoot];
      if (currentRoots.some(current => existingRoots.some(root => inside(current, root) || inside(root, current)))) {
        throw new ContextError('context_mismatch', 'Context storage collides with a registered context');
      }
    }
    // Refuse before creating state/pool directories or changing the registry.
    try {
      const info = await lstat(config.databasePath);
      if (!info.isFile() || info.nlink !== 1) throw new ConfigurationError('$.databasePath', 'Expected a regular file without hard links');
      if (info.size !== 0) throw new StorageError('not_empty', 'Initialisation requires an empty database path');
    } catch (error) { if (!missing(error)) throw error; }
    for (const [field, directory] of [['$.stateDirectory', config.stateDirectory], ['$.workspace.poolRoot', config.workspace.poolRoot]] as const) {
      try {
        if (!(await lstat(directory)).isDirectory()) throw new ConfigurationError(field, 'Expected a directory');
      } catch (error) { if (!missing(error)) throw error; }
    }
    try {
      if ((await readdir(config.workspace.poolRoot)).length !== 0) throw new ContextError('context_mismatch', 'A new context requires an empty workspace pool; preserve and inspect existing allocations');
    } catch (error) { if (!missing(error)) throw error; }
    // Prepare and flush the replacement before committing the database. Neither
    // SQLite nor rename can provide an atomic transaction across both files.
    const replacement = await open(temporary, 'wx', 0o600);
    try {
      await replacement.writeFile(`${JSON.stringify({ ...entries, [config.contextId]: file }, null, 2)}\n`);
      await replacement.sync();
    } finally { await replacement.close(); }
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(dirname(config.databasePath), { recursive: true, mode: 0o700 });
    await mkdir(config.workspace.poolRoot, { recursive: true, mode: 0o700 });
    using database = await Database.initialise(config.databasePath, {
      contextId: config.contextId, stateDirectory: config.stateDirectory,
      repository: { path: config.repository }, createdBy: options.caller,
      configuration: { revision: 1, digest, resolved: config, provenance: { file } },
    }, { location: { retainedRoot: dirname(config.databasePath), recyclableRoots: options.recyclableRoots ?? [] } });
    const genesis = database.events()[0]!;
    try { await rename(temporary, path); }
    catch {
      throw new ContextError('context_mismatch', 'Database committed but registry publication failed; preserve the database and repair the registry explicitly', { databasePath: config.databasePath, configurationFile: file, databaseId: genesis.payload.databaseId });
    }
    return { contextId: config.contextId, databaseId: genesis.payload.databaseId, configurationFile: file,
      stateDirectory: config.stateDirectory, databasePath: config.databasePath, poolRoot: config.workspace.poolRoot, digest, revision };
  } finally {
    try {
      try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
    } finally {
      lock.close();
    }
  }
}

/** Reconfiguration admits the new file only after checking the recorded identity and owners. */
export async function configureContext(selector: ContextSelector, options: ContextOptions & { caller: TaskActor; dryRun: boolean }) {
  if (options.caller.kind !== 'person') throw new CommandFailure('person_required');
  const configuration = await resolveContext(selector, options);
  const config = configuration.resolved;
  try { await lstat(config.databasePath); }
  catch (error) {
    if (missing(error)) throw new ContextError('context_mismatch', 'Cannot change databasePath or configure an uninitialised database', { fields: ['databasePath'] });
    throw error;
  }
  using database = await Database.open(config.databasePath, { readOnly: options.dryRun,
    location: { retainedRoot: dirname(config.databasePath), recyclableRoots: options.recyclableRoots ?? [] } });
  const result = await database.configureContext({ resolved: config, digest: configuration.digest, provenance: { file: configuration.file } }, options.caller, options.dryRun);
  if (result.fields.length) throw new ContextError('context_mismatch', 'Context identity cannot change', { fields: result.fields });
  if (result.blockers.length) throw new CommandFailure('policy_refused', { blockers: result.blockers }, nextAction('status.show', { attentionOnly: true, page: { after: null, limit: 100 } }, 'Resolve each blocking attempt, claim and effect before configuring the context.'));
  return { revision: result.revision, digest: result.digest, changedFields: result.changedFields,
    steps: result.changedFields.length ? [step('context.configure', config.contextId, [], false)] : [] };
}

/** All later operations admit the selected file before reading or mutating context state. */
export async function openContext(selector: ContextSelector, options: ContextOptions & { expectedRevision?: number; readOnly?: boolean } = {}) {
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) throw new ConfigurationError('$binding.expectedRevision', 'Expected a positive configuration revision');
  const configuration = await resolveContext(selector, options);
  const { resolved: config } = configuration;
  try { await lstat(config.databasePath); }
  catch (error) {
    if (missing(error)) throw new ContextError('not_initialised', 'The selected context database does not exist');
    throw error;
  }
  const database = await Database.open(config.databasePath, { readOnly: options.readOnly ?? true,
    location: { retainedRoot: dirname(config.databasePath), recyclableRoots: options.recyclableRoots ?? [] } });
  try {
    const events = database.events();
    const genesis = events.find(event => event.kind === 'database.initialised');
    const recorded = events.findLast(event => event.kind === 'context.configured');
    const currentRevision = options.expectedRevision ?? Number(recorded?.payload.revision);
    if (!recorded || recorded.payloadVersion !== 1 || recorded.payload.digest !== configuration.digest || recorded.payload.revision !== currentRevision) {
      throw new ContextError('config_changed', 'Configuration differs from the latest context.configured event', {
        recordedDigest: recorded?.payload.digest ?? null, currentDigest: configuration.digest,
        recordedRevision: recorded?.payload.revision ?? null, currentRevision,
      });
    }
    if (!genesis || genesis.payload.contextId !== config.contextId || genesis.payload.stateDirectory !== config.stateDirectory
      || (genesis.payload.repository as Record<string, unknown>)?.path !== config.repository) {
      throw new ContextError('context_mismatch', 'Configuration does not match the database context identity');
    }
    return { database, configuration: { ...configuration, revision: currentRevision }, databaseId: genesis.payload.databaseId };
  } catch (error) { database.close(); throw error; }
}
