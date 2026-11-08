import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalPath, ConfigurationError, inside, parseConfiguration } from './configuration.ts';
import type { ResolvedConfiguration } from './configuration.ts';
import { Database, StorageError } from './storage/database.ts';

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
  try { value = JSON.parse(await readFile(path, 'utf8')); }
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
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1) throw new ConfigurationError('$config', 'Configuration must be a regular, unlinked file');
  let source: string;
  try { source = await readFile(file, 'utf8'); }
  catch { throw new ConfigurationError('$config', 'Cannot read configuration'); }
  const configuration = await parseConfiguration(source, options.recyclableRoots);
  if (selector.context !== undefined && configuration.resolved.contextId !== selector.context) throw new ContextError('context_mismatch', 'Registry name and configuration contextId differ');
  return { ...configuration, file };
}

/** The registry lock serialises initialisers across names, including path collision checks. */
export async function initialiseContext(selector: ContextSelector, options: ContextOptions = {}): Promise<Record<string, unknown>> {
  const configuration = await resolveContext(selector, options);
  const { resolved: config, digest, revision, file } = configuration;
  const path = registryPath(options);
  await canonicalPath(dirname(path), '$registry');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ContextError('storage_busy', 'Context registry is locked; inspect its owner before retrying');
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const entries = await registry(path);
    if (Object.hasOwn(entries, config.contextId)) throw new ContextError('context_registered', 'Context name is already registered');
    for (const existingFile of Object.values(entries)) {
      const existing = (await resolveContext({ config: existingFile }, options)).resolved;
      if (inside(config.stateDirectory, existing.stateDirectory) || inside(existing.stateDirectory, config.stateDirectory)
        || config.databasePath === existing.databasePath || inside(config.workspace.poolRoot, existing.workspace.poolRoot)
        || inside(existing.workspace.poolRoot, config.workspace.poolRoot)) {
        throw new ContextError('context_mismatch', 'Context storage collides with a registered context');
      }
    }
    // Refuse before creating state/pool directories or changing the registry.
    try {
      const info = await lstat(config.databasePath);
      if (!info.isFile() || info.nlink !== 1) throw new ConfigurationError('$.databasePath', 'Expected an unlinked regular file');
      if (info.size !== 0) throw new StorageError('not_empty', 'Initialisation requires an empty database path');
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
      repository: { path: config.repository }, createdBy: { kind: 'person' },
      configuration: { revision: 1, digest, resolved: config, provenance: { file } },
    }, { location: { retainedRoot: config.stateDirectory, recyclableRoots: options.recyclableRoots ?? [] } });
    const genesis = database.events()[0]!;
    try { await rename(temporary, path); }
    catch {
      throw new ContextError('context_mismatch', 'Database committed but registry publication failed; preserve the database and repair the registry explicitly', { databasePath: config.databasePath, configurationFile: file, databaseId: genesis.payload.databaseId });
    }
    return { contextId: config.contextId, databaseId: genesis.payload.databaseId, configurationFile: file,
      stateDirectory: config.stateDirectory, databasePath: config.databasePath, poolRoot: config.workspace.poolRoot, digest, revision };
  } finally {
    try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
    await lock.close();
    await unlink(lockPath);
  }
}

/** All later operations admit the selected file before reading or mutating context state. */
export async function openContext(selector: ContextSelector, options: ContextOptions & { expectedRevision?: number; readOnly?: boolean } = {}) {
  const configuration = await resolveContext(selector, options);
  const { resolved: config } = configuration;
  const database = await Database.open(config.databasePath, { readOnly: options.readOnly ?? true,
    location: { retainedRoot: config.stateDirectory, recyclableRoots: options.recyclableRoots ?? [] } });
  try {
    const events = database.events();
    const genesis = events.find(event => event.kind === 'database.initialised');
    if (!genesis || genesis.payload.contextId !== config.contextId || genesis.payload.stateDirectory !== config.stateDirectory
      || (genesis.payload.repository as Record<string, unknown>)?.path !== config.repository) {
      throw new ContextError('context_mismatch', 'Configuration does not match the database context identity');
    }
    const recorded = events.findLast(event => event.kind === 'context.configured');
    const currentRevision = options.expectedRevision ?? configuration.revision;
    if (!recorded || recorded.payloadVersion !== 1 || recorded.payload.digest !== configuration.digest || recorded.payload.revision !== currentRevision) {
      throw new ContextError('config_changed', 'Configuration differs from the latest context.configured event', {
        recordedDigest: recorded?.payload.digest ?? null, currentDigest: configuration.digest,
        recordedRevision: recorded?.payload.revision ?? null, currentRevision,
      });
    }
    return { database, configuration, databaseId: genesis.payload.databaseId };
  } catch (error) { database.close(); throw error; }
}
