import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, open, realpath, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

export const applicationId = 0x444b5431;
export const schemaVersion = 1;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class StorageError extends Error {
  readonly code: 'path' | 'not_initialised' | 'family' | 'version' | 'not_empty' | 'busy' | 'conflict' | 'read_only';
  constructor(code: StorageError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'StorageError';
  }
}

/** Trusted host policy, not worker input. The host must inventory all recyclable roots. */
export interface StorageLocation {
  retainedRoot: string;
  recyclableRoots: readonly string[];
}

export interface OpenOptions {
  location: StorageLocation;
  readOnly?: boolean;
  retryMs?: number;
}

export interface InitialConfiguration {
  contextId: string;
  repository: JsonObject;
  stateDirectory: string;
  createdBy: JsonObject;
  configuration: {
    revision: 1;
    resolved: JsonObject;
    digest: string;
    provenance: JsonObject;
  };
}

export interface EventInput {
  sourceKey: string;
  kind: string;
  payloadVersion: number;
  correlationId: string;
  actor: JsonObject;
  occurredAt: string;
  payload: JsonObject;
  notification?: boolean;
  objectiveId?: string;
  taskId?: string;
  attemptId?: string;
  requestId?: string;
}

export interface StoredEvent extends EventInput {
  seq: number;
  id: string;
  recordedAt: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sqliteCode(error: unknown): number | undefined {
  return error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode : undefined;
}

function busy(error: unknown): boolean {
  const code = sqliteCode(error);
  return code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

function inside(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

async function canonical(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new StorageError('path', `Path must be absolute and canonical, without links: ${path}`);
  }
}

async function verifyPath(path: string, location: StorageLocation, missing: boolean): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new StorageError('path', `Database path must be absolute and canonical: ${path}`);
  await canonical(dirname(path));
  await canonical(location.retainedRoot);
  if (!inside(path, location.retainedRoot)) throw new StorageError('path', 'Database must be inside the retained local storage root');
  for (const root of location.recyclableRoots) {
    // Roots may not exist yet, but the policy must use absolute, normalised paths.
    if (!isAbsolute(root) || resolve(root) !== root) throw new StorageError('path', `Invalid recyclable root: ${root}`);
    if (inside(path, root)) throw new StorageError('path', `Database is inside recyclable storage: ${root}`);
    try {
      if (inside(path, await realpath(root))) throw new StorageError('path', `Database is inside recyclable storage: ${root}`);
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
  // Reject known network filesystems. Locality on other filesystems is a host precondition.
  const filesystem = await statfs(dirname(path));
  if ([0x6969, 0xff534d42, 0x517b, 0x564c].includes(filesystem.type >>> 0)) {
    throw new StorageError('path', 'Database requires local storage, not a network filesystem');
  }
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new StorageError('path', 'Database must be a regular file with no symbolic or hard links');
    await canonical(path);
    return true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    if (!missing) throw new StorageError('not_initialised', `Database is not initialised: ${path}`);
    return false;
  }
}

async function exclusiveProbe(path: string): Promise<void> {
  const probe = `${path}.probe-${randomUUID()}`;
  let created = false;
  try {
    const handle = await open(probe, 'wx', 0o600);
    created = true;
    await handle.close();
    try {
      const duplicate = await open(probe, 'wx', 0o600);
      await duplicate.close();
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return;
      throw error;
    }
    throw new StorageError('path', 'Filesystem does not support exclusive file creation');
  } finally { if (created) await unlink(probe); }
}

// Stable JSON allows duplicate source keys to compare logical content, not object key order.
function json(value: unknown): string {
  function normalise(input: unknown): Json {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(normalise);
    if (typeof input === 'object' && input !== null && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalise((input as Record<string, unknown>)[key])]));
    }
    throw new TypeError('Evidence must contain only JSON values');
  }
  return JSON.stringify(normalise(value));
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object');
  return JSON.parse(json(value)) as JsonObject;
}

function nonblank(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected nonblank text');
}

function eventContent(event: EventInput): string {
  nonblank(event.sourceKey);
  nonblank(event.kind);
  nonblank(event.correlationId);
  if (!Number.isSafeInteger(event.payloadVersion) || event.payloadVersion < 1) throw new TypeError('Invalid event payload version');
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new TypeError('Invalid event occurrence time');
  return json({ sourceKey: event.sourceKey, kind: event.kind, payloadVersion: event.payloadVersion,
    correlationId: event.correlationId, actor: object(event.actor), occurredAt: event.occurredAt,
    payload: object(event.payload), notification: event.notification ?? false,
    objectiveId: event.objectiveId ?? null, taskId: event.taskId ?? null,
    attemptId: event.attemptId ?? null, requestId: event.requestId ?? null });
}

/** The sole owner of SQLite connections and locking. No raw mutation API leaves this module. */
export class Database {
  private readonly db: DatabaseSync;
  readonly path: string;
  private readonly readOnly: boolean;
  private readonly retryMs: number;

  private constructor(db: DatabaseSync, path: string, readOnly: boolean, retryMs: number) {
    this.db = db;
    this.path = path;
    this.readOnly = readOnly;
    this.retryMs = retryMs;
  }

  private static retryLimit(options: OpenOptions): number {
    const limit = options.retryMs ?? 5000;
    if (!Number.isFinite(limit) || limit < 0 || limit > 60_000) throw new RangeError('retryMs must be between 0 and 60000');
    return limit;
  }

  private static async retry<T>(limit: number, operation: () => T, opening = false): Promise<T> {
    const deadline = performance.now() + limit;
    for (;;) {
      try { return operation(); }
      catch (error) {
        // SQLITE_IOERR_TRUNCATE can be transient on Windows after an unclean process exit.
        if (!busy(error) && !(opening && sqliteCode(error) === 1546)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new StorageError('busy', `Database remained busy after ${limit}ms; operation did not commit`);
        await sleep(Math.min(20, remaining));
      }
    }
  }

  private verifyVersion(): void {
    const family = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (family !== applicationId) throw new StorageError('family', `Unrecognised database family ${family}; expected ${applicationId} (DKT1); database version ${version}, supported version ${schemaVersion}`);
    if (version !== schemaVersion) throw new StorageError('version', `Unsupported database schema version ${version}; supported version ${schemaVersion}`);
  }

  private static connection(path: string, readOnly: boolean): DatabaseSync {
    return new DatabaseSync(path, { readOnly, timeout: 0, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  }

  private configure(): void {
    this.db.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON');
    if (!this.readOnly) {
      const mode = this.db.prepare('PRAGMA journal_mode = WAL').get()!.journal_mode;
      if (mode !== 'wal') throw new StorageError('path', 'Filesystem cannot provide SQLite WAL');
    }
  }

  /** Status/plans default to read-only and never create a database or probe file. */
  static async open(path: string, options: OpenOptions): Promise<Database> {
    const limit = this.retryLimit(options);
    await verifyPath(path, options.location, false);
    // Admission is read-only, before WAL or any other persistent setting can alter a refused file.
    await this.retry(limit, () => {
      const check = new Database(this.connection(path, true), path, true, limit);
      try { check.verifyVersion(); } finally { check.close(); }
    }, true);
    const readOnly = options.readOnly ?? true;
    if (!readOnly) await exclusiveProbe(path);
    return this.retry(limit, () => {
      const result = new Database(this.connection(path, readOnly), path, readOnly, limit);
      try {
        result.verifyVersion();
        result.configure();
        return result;
      } catch (error) { result.close(); throw error; }
    }, true);
  }

  /** Deliberate creation only. A nonempty file is never adopted or replaced. */
  static async initialise(path: string, initial: InitialConfiguration, options: OpenOptions): Promise<Database> {
    const limit = this.retryLimit(options);
    nonblank(initial.contextId);
    nonblank(initial.configuration.digest);
    if (initial.configuration.revision !== 1) throw new TypeError('Initial configuration revision must be 1');
    const configuration = object(initial.configuration);
    const repository = object(initial.repository);
    const actor = object(initial.createdBy);
    await canonical(initial.stateDirectory);
    const exists = await verifyPath(path, options.location, true);
    if (!inside(path, initial.stateDirectory)) throw new StorageError('path', 'Database must be inside its state directory');
    if (exists && (await lstat(path)).size !== 0) throw new StorageError('not_empty', 'Initialisation requires an empty path; existing file was not changed');
    await exclusiveProbe(path);
    if (!exists) {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
    }
    const databaseId = randomUUID();
    const now = new Date().toISOString();
    const result = await this.retry(limit, () => {
      const candidate = new Database(this.connection(path, false), path, false, limit);
      try { candidate.configure(); return candidate; }
      catch (error) { candidate.close(); throw error; }
    }, true);
    try {
      await result.write(() => {
        const count = Number(result.db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n);
        const family = Number(result.db.prepare('PRAGMA application_id').get()!.application_id);
        const version = Number(result.db.prepare('PRAGMA user_version').get()!.user_version);
        if (count !== 0 || family !== 0 || version !== 0) throw new StorageError('not_empty', 'Database was initialised by another opener; nothing changed');
        result.db.exec(schema);
        result.insertEvent({ sourceKey: 'database.initialised', kind: 'database.initialised', payloadVersion: 1,
          correlationId: databaseId, actor, occurredAt: now,
          payload: { databaseId, contextId: initial.contextId, repository, stateDirectory: initial.stateDirectory,
            createdBy: actor, schemaFamily: applicationId } });
        result.insertEvent({ sourceKey: 'context.configured:1', kind: 'context.configured', payloadVersion: 1,
          correlationId: databaseId, actor, occurredAt: now, payload: configuration });
      }, false);
      return result;
    } catch (error) { result.close(); throw error; }
  }

  private async write<T>(change: () => T, verify = true): Promise<T> {
    if (this.readOnly) throw new StorageError('read_only', 'Database was opened read-only');
    return Database.retry(this.retryMs, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (verify) this.verifyVersion();
        const value = change();
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
          throw new TypeError('Database transaction callbacks must be synchronous');
        }
        this.db.exec('COMMIT');
        return value;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        if (sqliteCode(error) !== undefined && (sqliteCode(error)! & 0xff) === 19) {
          throw new StorageError('conflict', `Database constraint conflict: ${String(error)}`);
        }
        throw error;
      }
    });
  }

  private insertEvent(event: EventInput): StoredEvent {
    const content = eventContent(event);
    const previous = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(event.sourceKey);
    if (previous) {
      const stored = this.decodeEvent(previous);
      if (eventContent(stored) !== content) throw new StorageError('conflict', `Event source key has different content: ${event.sourceKey}`);
      return stored;
    }
    const id = randomUUID();
    const recordedAt = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT INTO events
      (id, source_key, kind, payload_version, objective_id, task_id, attempt_id, request_id,
       correlation_id, actor, occurred_at, recorded_at, notification, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, event.sourceKey, event.kind,
      event.payloadVersion, event.objectiveId ?? null, event.taskId ?? null, event.attemptId ?? null,
      event.requestId ?? null, event.correlationId, json(event.actor), event.occurredAt, recordedAt,
      event.notification ? 1 : 0, json(event.payload));
    return { ...event, notification: event.notification ?? false, id, recordedAt, seq: Number(inserted.lastInsertRowid) };
  }

  /** Insert-only evidence. A batch and its source-key checks commit or roll back together. */
  async appendEvents(events: readonly EventInput[]): Promise<StoredEvent[]> {
    // Detach caller-owned values before waiting for the write lock.
    const inputs = events.map(event => {
      eventContent(event);
      return JSON.parse(json(event)) as EventInput;
    });
    return this.write(() => inputs.map(event => this.insertEvent(event)));
  }

  private decodeEvent(row: Record<string, unknown>): StoredEvent {
    const event: StoredEvent = { seq: Number(row.seq), id: String(row.id), sourceKey: String(row.source_key),
      kind: String(row.kind), payloadVersion: Number(row.payload_version), correlationId: String(row.correlation_id),
      actor: object(JSON.parse(String(row.actor))), occurredAt: String(row.occurred_at), recordedAt: String(row.recorded_at),
      notification: row.notification === 1, payload: object(JSON.parse(String(row.payload))),
      ...(row.objective_id === null ? {} : { objectiveId: String(row.objective_id) }),
      ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
      ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
      ...(row.request_id === null ? {} : { requestId: String(row.request_id) }) };
    eventContent(event);
    return event;
  }

  /** Connection diagnostics; requesting full fsync is not proof that the OS honours it. */
  settings(): { journalMode: string; foreignKeys: number; synchronous: number; busyTimeout: number; fullfsync: number; checkpointFullfsync: number } {
    const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get()!)[0];
    return { journalMode: String(pragma('journal_mode')), foreignKeys: Number(pragma('foreign_keys')),
      synchronous: Number(pragma('synchronous')), busyTimeout: Number(pragma('busy_timeout')),
      fullfsync: Number(pragma('fullfsync')), checkpointFullfsync: Number(pragma('checkpoint_fullfsync')) };
  }

  events(): StoredEvent[] {
    this.db.exec('BEGIN');
    try {
      this.verifyVersion();
      const events = this.db.prepare('SELECT * FROM events ORDER BY seq').all().map(row => this.decodeEvent(row));
      this.db.exec('COMMIT');
      return events;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { if (this.db.isOpen) this.db.close(); }
  [Symbol.dispose](): void { this.close(); }
}
