import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, open, realpath, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { addTaskInput, taskActor, taskDefinition, taskIds, taskSlug, taskText } from './tasks.ts';
import { workerReference, workerHost } from './launch.ts';
import type { WorkerReference, InitialPromptAdmission, LaunchDecision, WorkerHost } from './launch.ts';
import { readWorkerResult, workerObservation } from './results.ts';
import type { ResultBinding, ValidatedResult, WorkerObservation } from './results.ts';
import type { GitRepository } from '../adapters/repository.ts';
import { checkEvidenceKey } from '../check-policy.ts';
import type { CheckAdmission, CheckRunInput, CheckRunResult } from './checks.ts';
import type { AcceptInput, ReturnInput, FinalisationPlan } from './completion.ts';
import type { ContextChecks } from '../check-policy.ts';
import type { AddTaskInput, Task, TaskActor, TaskDefinition, TaskKind, TaskState } from './tasks.ts';

import { claimIdentity, claimInput, heartbeatStatus, text, timestamp } from './claims.ts';
import type { AdmissionBlocker, Claim, ClaimIdentity, ClaimInput } from './claims.ts';
import { allocationInput, reservationEvidence, reservationInput, resolveReservationConfig } from './reservations.ts';
import { requireProfile, unknownProfile, UnknownProfileError } from '../profiles.ts';
import type { Allocation, Attempt, Reservation, ReservationInput } from './reservations.ts';
import { commandInput, effectInput } from './requests.ts';
import type { CommandInput, EffectInput, EffectOutcome, EffectState, EffectTarget, StoredRequest } from './requests.ts';

export const applicationId = 0x444b5431;
export const schemaVersion = 1;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class StorageError extends Error {
  readonly code: 'path' | 'not_initialised' | 'family' | 'version' | 'not_empty' | 'busy' | 'conflict' | 'read_only' | 'request_input_mismatch' | 'result_invalid' | 'result_identity_mismatch' | 'result_discrepancy';
  constructor(code: StorageError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'StorageError';
  }
}

export class NoEligibleTaskError extends StorageError {
  readonly skippedTasks: { taskId: string; reason: string }[];
  constructor(skippedTasks: { taskId: string; reason: string }[]) {
    super('conflict', 'No eligible task');
    this.skippedTasks = skippedTasks;
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

function eventContent(event: EventInput, stored = false): string {
  const keys = ['sourceKey', 'kind', 'payloadVersion', 'correlationId', 'actor', 'occurredAt', 'payload',
    'notification', 'objectiveId', 'taskId', 'attemptId', 'requestId',
    ...(stored ? ['seq', 'id', 'recordedAt'] : [])];
  if (Object.keys(event).some(key => !keys.includes(key))) throw new TypeError('Unknown event field');
  if (event.notification !== undefined && typeof event.notification !== 'boolean') throw new TypeError('Invalid notification flag');
  for (const id of [event.objectiveId, event.taskId, event.attemptId, event.requestId]) {
    if (id !== undefined) nonblank(id);
  }
  nonblank(event.sourceKey);
  nonblank(event.kind);
  nonblank(event.correlationId);
  if (!Number.isSafeInteger(event.payloadVersion) || event.payloadVersion < 1) throw new TypeError('Invalid event payload version');
  if (typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) throw new TypeError('Invalid event occurrence time');
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
  private readonly recyclableRoots: string[];

  private constructor(db: DatabaseSync, path: string, readOnly: boolean, retryMs: number, recyclableRoots: readonly string[]) {
    this.db = db;
    this.path = path;
    this.readOnly = readOnly;
    this.retryMs = retryMs;
    this.recyclableRoots = [...recyclableRoots];
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
    const mode = this.db.prepare(this.readOnly ? 'PRAGMA journal_mode' : 'PRAGMA journal_mode = WAL').get()!.journal_mode;
    if (mode !== 'wal') throw new StorageError('path', this.readOnly
      ? 'Database is not in WAL mode; a writable opener must configure it first'
      : 'Filesystem cannot provide SQLite WAL');
  }

  /** Status/plans default to read-only and never create a database or probe file. */
  static async open(path: string, options: OpenOptions): Promise<Database> {
    const limit = this.retryLimit(options);
    await verifyPath(path, options.location, false);
    // Admission is read-only, before WAL or any other persistent setting can alter a refused file.
    await this.retry(limit, () => {
      const check = new Database(this.connection(path, true), path, true, limit, options.location.recyclableRoots);
      try { check.verifyVersion(); } finally { check.close(); }
    }, true);
    const readOnly = options.readOnly ?? true;
    if (!readOnly) await exclusiveProbe(path);
    return this.retry(limit, () => {
      const result = new Database(this.connection(path, readOnly), path, readOnly, limit, options.location.recyclableRoots);
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
    if (exists && (await lstat(path)).size !== 0) throw new StorageError('not_empty', 'Initialisation requires an empty path; existing file was not changed');
    await exclusiveProbe(path);
    if (!exists) {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
    }
    const databaseId = randomUUID();
    const now = new Date().toISOString();
    const result = await this.retry(limit, () => {
      const candidate = new Database(this.connection(path, false), path, false, limit, options.location.recyclableRoots);
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
      if (eventContent(stored, true) !== content) throw new StorageError('conflict', `Event source key has different content: ${event.sourceKey}`);
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
    eventContent(event, true);
    return event;
  }

  private taskRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new StorageError('conflict', `Unknown task: ${id}`);
    return row;
  }

  private decodeTask(row: Record<string, unknown>): Task {
    return { id: String(row.id), title: String(row.title), instructions: String(row.instructions),
      criteria: JSON.parse(String(row.criteria)) as string[], kind: row.kind as TaskKind,
      profile: row.profile === null ? null : String(row.profile),
      objectiveId: row.objective_id === null ? null : String(row.objective_id),
      position: Number(row.position), state: row.state as TaskState,
      holdReason: row.hold_reason === null ? null : String(row.hold_reason),
      definitionRevision: Number(row.definition_revision), decisionRevision: Number(row.decision_revision),
      blockerIds: this.db.prepare('SELECT blocker_id FROM dependencies WHERE task_id = ? ORDER BY blocker_id')
        .all(String(row.id)).map(item => String(item.blocker_id)) };
  }

  private snapshot<T>(read: () => T): T {
    this.db.exec('BEGIN');
    try {
      this.verifyVersion();
      const result = read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  task(id: string): Task {
    taskText(id);
    return this.snapshot(() => this.decodeTask(this.taskRow(id)));
  }

  tasks(): Task[] {
    return this.snapshot(() => this.db.prepare('SELECT * FROM tasks ORDER BY position').all().map(row => this.decodeTask(row)));
  }

  readyTasks(): Task[] {
    return this.snapshot(() => this.db.prepare(`SELECT * FROM tasks AS task
      WHERE state = 'queued' AND hold_reason IS NULL AND NOT EXISTS
        (SELECT 1 FROM dependencies JOIN tasks AS blocker ON blocker.id = blocker_id
         WHERE task_id = task.id AND blocker.state <> 'done')
      ORDER BY position`).all().map(row => this.decodeTask(row)));
  }

  private taskEvent(operation: string, actor: TaskActor, taskId: string | undefined, payload: JsonObject): void {
    const actionId = randomUUID();
    this.insertEvent({ sourceKey: `action:${actionId}`, kind: 'action.recorded', payloadVersion: 1,
      correlationId: actionId, actor, occurredAt: new Date().toISOString(),
      ...(taskId === undefined ? {} : { taskId }),
      payload: { actionId, operation, person: actor.id, membershipBefore: null, membershipAfter: null,
        classification: null, ...payload } });
  }

  private changed(result: { changes: number | bigint }): void {
    if (Number(result.changes) !== 1) throw new StorageError('conflict', 'Record changed since it was read');
  }

  private insertBlocker(taskId: string, blockerId: string): boolean {
    this.taskRow(taskId);
    this.taskRow(blockerId);
    if (taskId === blockerId) throw new StorageError('conflict', 'A task cannot block itself');
    const cycle = this.db.prepare(`WITH RECURSIVE blockers(id) AS
      (SELECT blocker_id FROM dependencies WHERE task_id = ? UNION
       SELECT blocker_id FROM dependencies JOIN blockers ON task_id = blockers.id)
      SELECT 1 FROM blockers WHERE id = ?`).get(blockerId, taskId);
    if (cycle) throw new StorageError('conflict', 'Blocker would create a cycle');
    if (this.db.prepare('SELECT 1 FROM dependencies WHERE task_id = ? AND blocker_id = ?').get(taskId, blockerId)) return false;
    this.db.prepare('INSERT INTO dependencies (task_id, blocker_id) VALUES (?, ?)').run(taskId, blockerId);
    return true;
  }

  private writeTask<T>(command: CommandInput | undefined, change: () => T): Promise<T> {
    if (command) commandInput(command);
    return this.write(() => {
      const previous = command && this.duplicateRequest(command, 'command');
      if (previous) return previous.result!.value as T;
      const value = change();
      if (command) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO requests (id, request_key, category, operation, caller, fingerprint, input, target, state, result, created_at)
          VALUES (?, ?, 'command', ?, ?, ?, ?, '{}', 'succeeded', ?, ?)`)
          .run(id, command.requestKey, command.operation, json(command.caller), command.fingerprint, json(command.input), json({ value }), new Date().toISOString());
        this.storageEvent('request.succeeded', command.caller, { operation: command.operation }, id);
      }
      return value;
    });
  }

  private currentTaskConfiguration(): JsonObject {
    const row = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get();
    return row ? this.decodeEvent(row).payload.resolved as JsonObject : {};
  }

  async addTask(input: AddTaskInput, actor: TaskActor, command?: CommandInput): Promise<Task> {
    addTaskInput(input);
    taskActor(actor);
    const value = JSON.parse(json(input)) as AddTaskInput;
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      requireProfile(this.currentTaskConfiguration(), value.profile);
      let id = value.id;
      if (id === undefined) {
        const base = taskSlug(value.title);
        id = base;
        for (let suffix = 2; this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id); suffix++) id = `${base}-${suffix}`;
      }
      const position = Number(this.db.prepare('SELECT coalesce(max(position), 0) + 1 AS position FROM tasks').get()!.position);
      if (!Number.isSafeInteger(position)) throw new StorageError('conflict', 'Task position range exhausted');
      this.db.prepare(`INSERT INTO tasks (id, title, instructions, criteria, kind, profile, objective_id, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, value.title, value.instructions ?? '', json(value.criteria ?? []),
        value.kind ?? 'code', value.profile ?? null, value.objectiveId ?? null, position);
      for (const blockerId of value.blockerIds ?? []) this.insertBlocker(id, blockerId);
      const task = this.decodeTask(this.taskRow(id));
      this.taskEvent('task.add', person, id, { after: object(task) });
      return task;
    });
  }

  async updateTaskDefinition(id: string, patch: Partial<TaskDefinition>, actor: TaskActor, command?: CommandInput, expectedRevision?: number): Promise<Task> {
    taskText(id);
    taskDefinition(patch);
    taskActor(actor);
    const value = JSON.parse(json(patch)) as Partial<TaskDefinition>;
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      const before = this.decodeTask(this.taskRow(id));
      if (expectedRevision !== undefined && before.definitionRevision !== expectedRevision) throw new StorageError('conflict', 'Task revision changed');
      if ((before.kind !== 'review' && value.kind === 'review') || (before.kind === 'review'
        && ((value.kind !== undefined && value.kind !== before.kind) || (value.criteria !== undefined && json(value.criteria) !== json(before.criteria))
          || (value.instructions !== undefined && value.instructions !== before.instructions)))) throw new StorageError('conflict', 'Linked review definition cannot change');
      requireProfile(this.currentTaskConfiguration(), value.profile);
      const after = { ...before, ...value };
      if (json(before) === json(after)) return before;
      this.changed(this.db.prepare(`UPDATE tasks SET title = ?, instructions = ?, criteria = ?, kind = ?,
        profile = ?, objective_id = ?, definition_revision = definition_revision + 1
        WHERE id = ? AND definition_revision = ?`).run(after.title, after.instructions, json(after.criteria),
        after.kind, after.profile, after.objectiveId, id, before.definitionRevision));
      const task = this.decodeTask(this.taskRow(id));
      this.taskEvent('task.update', person, id, { before: object(before), after: object(task) });
      return task;
    });
  }

  async addBlocker(taskId: string, blockerId: string, actor: TaskActor, command?: CommandInput): Promise<Task> {
    taskText(taskId); taskText(blockerId); taskActor(actor);
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      if (this.insertBlocker(taskId, blockerId)) this.taskEvent('task.block', person, taskId, { blockerId });
      return this.decodeTask(this.taskRow(taskId));
    });
  }

  async removeBlocker(taskId: string, blockerId: string, actor: TaskActor, command?: CommandInput): Promise<Task> {
    taskText(taskId); taskText(blockerId); taskActor(actor);
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      this.taskRow(taskId); this.taskRow(blockerId);
      const result = this.db.prepare('DELETE FROM dependencies WHERE task_id = ? AND blocker_id = ?').run(taskId, blockerId);
      if (Number(result.changes) !== 0) this.taskEvent('task.unblock', person, taskId, { blockerId });
      return this.decodeTask(this.taskRow(taskId));
    });
  }

  /** A complete permutation avoids ambiguous partial-order edits. */
  async reorderTasks(ids: readonly string[], actor: TaskActor, command?: CommandInput): Promise<Task[]> {
    taskIds(ids); taskActor(actor);
    const order = [...ids];
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      const before = this.db.prepare('SELECT id, position FROM tasks ORDER BY position').all();
      if (before.length !== order.length || before.some(row => !order.includes(String(row.id)))) {
        throw new StorageError('conflict', 'Reorder must name every task exactly once');
      }
      if (before.every((row, index) => row.id === order[index])) return before.map(row => this.decodeTask(this.taskRow(String(row.id))));
      // Move above the old range first, preserving positive unique positions throughout.
      const offset = before.reduce((max, row) => Math.max(max, Number(row.position)), 0);
      if (!Number.isSafeInteger(offset + order.length)) throw new StorageError('conflict', 'Task position range exhausted');
      const move = this.db.prepare('UPDATE tasks SET position = ? WHERE id = ? AND position = ?');
      for (let index = 0; index < before.length; index++) {
        const row = before[index]!;
        this.changed(move.run(offset + index + 1, String(row.id), Number(row.position)));
      }
      for (let index = 0; index < order.length; index++) {
        const oldIndex = before.findIndex(row => row.id === order[index]);
        this.changed(move.run(index + 1, order[index]!, offset + oldIndex + 1));
      }
      this.taskEvent('task.reorder', person, undefined, { before: before.map(row => String(row.id)), after: order });
      return order.map(id => this.decodeTask(this.taskRow(id)));
    });
  }

  private async decideTask(id: string, operation: 'hold' | 'release' | 'done' | 'reopen', actor: TaskActor, reason?: string, command?: CommandInput): Promise<Task> {
    taskText(id); taskActor(actor);
    const person = object(actor) as TaskActor;
    return this.writeTask(command, () => {
      const before = this.decodeTask(this.taskRow(id));
      const state = operation === 'done' ? 'done' : operation === 'reopen' ? 'queued' : before.state;
      const holdReason = operation === 'hold' ? reason! : operation === 'release' ? null : before.holdReason;
      if (state === before.state && holdReason === before.holdReason) return before;
      this.changed(this.db.prepare(`UPDATE tasks SET state = ?, hold_reason = ?, decision_revision = decision_revision + 1
        WHERE id = ? AND state = ? AND decision_revision = ?`).run(state, holdReason, id, before.state, before.decisionRevision));
      const task = this.decodeTask(this.taskRow(id));
      this.taskEvent(`task.${operation}`, person, id, { before: object(before), after: object(task),
        ...(operation === 'done' ? { judgement: 'person' } : {}) });
      return task;
    });
  }

  async holdTask(id: string, reason: string, actor: TaskActor, command?: CommandInput): Promise<Task> {
    taskText(reason);
    if ([...reason].length > 200 || /[\r\n\u2028\u2029]/u.test(reason)) throw new TypeError('Hold reason must be one line of at most 200 characters');
    return this.decideTask(id, 'hold', actor, reason, command);
  }

  releaseTask(id: string, actor: TaskActor, command?: CommandInput): Promise<Task> { return this.decideTask(id, 'release', actor, undefined, command); }
  markTaskDone(id: string, actor: TaskActor, command?: CommandInput): Promise<Task> { return this.decideTask(id, 'done', actor, undefined, command); }
  reopenTask(id: string, actor: TaskActor, command?: CommandInput): Promise<Task> { return this.decideTask(id, 'reopen', actor, undefined, command); }

  private attemptRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    if (!row) throw new StorageError('conflict', `Unknown attempt: ${id}`);
    return row;
  }

  private decodeAttempt(row: Record<string, unknown>): Attempt {
    return { id: String(row.id), taskId: String(row.task_id), number: Number(row.number), revision: Number(row.revision),
      executionOpen: row.execution_open === 1, phase: String(row.phase), launchState: String(row.launch_state),
      specification: object(JSON.parse(String(row.specification))),
      allocation: row.allocation === null ? null : object(JSON.parse(String(row.allocation))) as Allocation,
      leaseState: String(row.lease_state), outcome: row.outcome === null ? null : String(row.outcome),
      candidate: row.candidate === null ? null : object(JSON.parse(String(row.candidate))) };
  }

  attempt(id: string): Attempt {
    text(id);
    return this.snapshot(() => this.decodeAttempt(this.attemptRow(id)));
  }

  /** The key comparison precedes selection, policy resolution and all admission decisions. */
  async reserveAttempt(input: ReservationInput, dryRun = false): Promise<Reservation> {
    reservationInput(input);
    const value = JSON.parse(json(input)) as ReservationInput;
    const logicalInput = { taskId: value.taskId ?? null, profile: value.profile ?? null,
      sourceAttemptId: value.sourceAttemptId ?? null, note: value.note ?? null };
    const command: CommandInput = { requestKey: value.requestKey, operation: 'attempt.dispatch', caller: value.caller,
      input: logicalInput, fingerprint: createHash('sha256').update(json(logicalInput)).digest('hex') };
    const build = () => {
      const previous = this.duplicateRequest(command, 'command');
      if (previous) {
        if (!previous.attemptId) throw new StorageError('conflict', 'Dispatch request has no reservation');
        return { requestId: previous.id, replayed: true, skippedTasks: (previous.result?.skippedTasks ?? []) as { taskId: string; reason: string }[],
          attempt: this.decodeAttempt(this.attemptRow(previous.attemptId)) };
      }
      taskActor(value.caller);
      reservationEvidence(value);
      if (value.sourceAttemptId !== undefined) throw new StorageError('conflict', 'Continuation is not supported by dispatch');
      const configured = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get();
      const genesis = this.db.prepare("SELECT * FROM events WHERE source_key = 'database.initialised'").get();
      if (!configured || !genesis) throw new StorageError('conflict', 'Missing context identity or configuration');
      const configEvent = this.decodeEvent(configured), identityEvent = this.decodeEvent(genesis);
      if (configEvent.payloadVersion !== 1 || identityEvent.payloadVersion !== 1) throw new StorageError('version', 'Unsupported reservation evidence');
      const identity = identityEvent.payload;
      text(identity.databaseId); text(identity.contextId);
      const repository = object(identity.repository);
      const blockers = this.readAdmissionBlockers(Date.now());
      if (blockers.length) throw new StorageError('conflict', `Admission blocked: ${json(blockers)}`);
      const candidates = value.taskId === undefined
        ? this.db.prepare('SELECT * FROM tasks ORDER BY position').all()
        : [this.taskRow(value.taskId)];
      const resolved = configEvent.payload.resolved as JsonObject;
      requireProfile(resolved, value.profile);
      const skippedTasks: { taskId: string; reason: string }[] = [];
      for (const row of candidates) {
        const task = this.decodeTask(row);
        const problem = unknownProfile(resolved, task.profile);
        if (problem && value.taskId !== undefined) throw new UnknownProfileError(problem);
        const config = resolveReservationConfig(configEvent.payload, problem ? { ...task, profile: null } : task, value.profile);
        if ((value.expectedConfigRevision !== undefined && value.expectedConfigRevision !== config.revision) ||
          (value.expectedConfigDigest !== undefined && value.expectedConfigDigest !== config.digest)) throw new StorageError('conflict', 'Configuration changed');
        const unavailable = task.state !== 'queued' || task.holdReason !== null ||
          this.db.prepare(`SELECT 1 FROM dependencies JOIN tasks AS blocker ON blocker.id = blocker_id
            WHERE task_id = ? AND blocker.state <> 'done' LIMIT 1`).get(task.id) ||
          this.db.prepare("SELECT 1 FROM attempts WHERE task_id = ? AND (execution_open = 1 OR lease_state IN ('held', 'unknown')) LIMIT 1").get(task.id) ||
          Number(this.db.prepare('SELECT count(*) AS count FROM attempts WHERE task_id = ?').get(task.id)!.count) >= config.maxAttemptsPerTask;
        if (unavailable || task.objectiveId !== null) {
          if (value.taskId !== undefined) throw new StorageError('conflict', task.objectiveId !== null ? 'Objective-linked tasks are not supported' : 'Task is not eligible for reservation');
          continue;
        }
        if (problem) {
          skippedTasks.push({ taskId: task.id, reason: problem.reason });
          continue;
        }
        if ((value.expectedDefinitionRevision !== undefined && value.expectedDefinitionRevision !== task.definitionRevision) ||
          (value.expectedDecisionRevision !== undefined && value.expectedDecisionRevision !== task.decisionRevision)) throw new StorageError('conflict', 'Task revision changed');
        if (Number(this.db.prepare('SELECT count(*) AS count FROM attempts WHERE execution_open = 1').get()!.count) >= config.maxAttempts) {
          throw new StorageError('conflict', 'Context attempt capacity reached');
        }
        const id = randomUUID(), now = new Date().toISOString();
        const number = Number(this.db.prepare('SELECT coalesce(max(number), 0) + 1 AS number FROM attempts WHERE task_id = ?').get(task.id)!.number);
        if (!Number.isSafeInteger(number)) throw new StorageError('conflict', 'Attempt number range exhausted');
        const outputRef = `refs/heads/docket/${identity.databaseId}/${id}`;
        const holder = { databaseId: identity.databaseId, contextId: identity.contextId, taskId: task.id, attemptId: id };
        const specification: JsonObject = { version: 1, ...holder, number, task: object(task),
          definitionRevision: task.definitionRevision, decisionRevision: task.decisionRevision, criteria: task.criteria,
          objectiveId: null, delivery: object({ ...value.delivery, baseRef: config.baseBranch, startingCommit: value.startingCommit, outputBranch: outputRef }),
          baseBranch: config.baseBranch, targetBranch: config.finalisation.targetBranch!, outputRef, startingCommit: value.startingCommit,
          resultPath: join(String(identity.stateDirectory), 'attempts', id, 'result.json'),
          repository, workspace: { holder, pool: config.poolRoot },
          profile: config.profile, profileName: config.profileName, profileSource: config.profileSource,
          finalisation: config.finalisation, checks: value.checks,
          configuration: { revision: config.revision, digest: config.digest, sourceEventId: configEvent.id } };
        if (dryRun) return { requestId: randomUUID(), replayed: false, skippedTasks, attempt: { id, taskId: task.id, number, revision: 1,
          executionOpen: true, phase: 'reserved', launchState: 'pending', specification, allocation: null,
          leaseState: 'none', outcome: null, candidate: null } };
        const requestId = this.recordCommandInTransaction(command).id;
        this.db.prepare(`INSERT INTO attempts (id, task_id, number, phase, specification, output_ref, created_at)
          VALUES (?, ?, ?, 'reserved', ?, ?, ?)`).run(id, task.id, number, json(specification), outputRef, now);
        this.bindCommandInTransaction(requestId, id, { skippedTasks });
        this.insertEvent({ sourceKey: `attempt.reserved:${id}`, kind: 'attempt.reserved', payloadVersion: 1,
          correlationId: requestId, actor: value.caller, occurredAt: now, taskId: task.id, attemptId: id, requestId,
          payload: { specification, request: object(command) } });
        return { requestId, replayed: false, skippedTasks, attempt: this.decodeAttempt(this.attemptRow(id)) };
      }
      throw new NoEligibleTaskError(skippedTasks);
    };
    return dryRun ? this.snapshot(build) : this.write(build);
  }

  /** One durable intent per reservation. An existing intent is never permission to call again. */
  async beginWorkspaceAcquisition(attemptId: string, requestId: string, executor: ClaimIdentity, caller: TaskActor): Promise<{ effect: StoredRequest; claimed: boolean }> {
    text(attemptId); text(requestId); claimIdentity(executor); taskActor(caller);
    const expected = { ...executor }, actor = object(caller);
    return this.write(() => {
      const attempt = this.attemptRow(attemptId), command = this.decodeRequest(this.requestRow(requestId));
      if (command.category !== 'command' || command.operation !== 'attempt.dispatch' || command.attemptId !== attemptId || json(command.caller) !== json(actor)) {
        throw new StorageError('conflict', 'Acquisition must match its reservation command and caller');
      }
      const existing = this.db.prepare("SELECT * FROM requests WHERE attempt_id = ? AND operation = 'workspace.acquire'").get(attemptId);
      if (existing) return { effect: this.decodeRequest(existing), claimed: false };
      const claim = this.activeClaim(expected);
      if (json(claim.ownerRef) !== json(actor) || heartbeatStatus(claim.heartbeatAt, Date.now()) !== 'fresh' ||
        (claim.attemptId !== undefined && claim.attemptId !== attemptId) || claim.objectiveId !== undefined) throw new StorageError('conflict', 'Acquisition executor does not match caller and scope');
      const blockers = this.readAdmissionBlockers(Date.now());
      if (blockers.length) throw new StorageError('conflict', `Admission blocked: ${json(blockers)}`);
      if (attempt.phase !== 'reserved' || attempt.launch_state !== 'pending' || attempt.allocation !== null || attempt.lease_state !== 'none') throw new StorageError('conflict', 'Attempt is not reserved');
      const specification = object(JSON.parse(String(attempt.specification)));
      const input = { workspace: specification.workspace!, repository: specification.repository!, outputRef: specification.outputRef!, startingCommit: specification.startingCommit! };
      const recorded = this.recordEffectInTransaction({ requestKey: `workspace.acquire:${attemptId}`, operation: 'workspace.acquire',
        parentId: requestId, attemptId, caller: actor, executor: expected,
        fingerprint: createHash('sha256').update(json(input)).digest('hex'), input,
        target: { kind: 'workspace', reference: object(specification.workspace) } });
      const effect = this.claimEffectInTransaction(recorded.id, expected);
      return { effect, claimed: true };
    });
  }

  /** Allocation and effect confirmation are one write-once fact, with both explanatory events. */
  async recordAllocation(attemptId: string, effectId: string, executor: ClaimIdentity, allocation: Allocation): Promise<Allocation> {
    text(attemptId); text(effectId); claimIdentity(executor); allocationInput(allocation);
    const expected = { ...executor }, value = object(allocation) as Allocation;
    return this.write(() => {
      const attempt = this.attemptRow(attemptId), effect = this.decodeRequest(this.requestRow(effectId));
      if (effect.operation !== 'workspace.acquire' || effect.attemptId !== attemptId || effect.claimId !== expected.claimId ||
        this.claimRow(expected.claimId).generation !== expected.generation) throw new StorageError('conflict', 'Allocation effect identity mismatch');
      if (attempt.allocation !== null) {
        const recorded = object(JSON.parse(String(attempt.allocation))) as Allocation;
        if (json(recorded) !== json(value) || effect.state !== 'succeeded') throw new StorageError('conflict', 'Allocation is immutable');
        return recorded;
      }
      this.effectExecutor(effect, expected);
      if (effect.state !== 'claimed' || attempt.phase !== 'reserved' || attempt.lease_state !== 'none') throw new StorageError('conflict', 'Acquisition is not awaiting confirmation');
      const spec = object(JSON.parse(String(attempt.specification))), workspace = object(spec.workspace);
      if (json(value.holder) !== json(workspace.holder) || value.pool !== workspace.pool ||
        value.path === value.pool || !inside(value.path, value.pool) ||
        json(value.repository) !== json(spec.repository) || value.outputRef !== spec.outputRef || value.startingCommit !== spec.startingCommit) throw new StorageError('conflict', 'Allocation does not match specification');
      this.changed(this.db.prepare(`UPDATE attempts SET allocation = ?, lease_id = ?, lease_state = 'held', phase = 'allocated', revision = revision + 1
        WHERE id = ? AND allocation IS NULL AND phase = 'reserved' AND revision = ?`).run(json(value), value.leaseId, attemptId, Number(attempt.revision)));
      this.changed(this.db.prepare("UPDATE requests SET state = 'succeeded', result = ?, revision = revision + 1 WHERE id = ? AND state = 'claimed' AND revision = ?")
        .run(json({ allocation: value }), effectId, effect.revision));
      this.insertEvent({ sourceKey: `attempt.allocated:${attemptId}`, kind: 'attempt.allocated', payloadVersion: 1,
        correlationId: effectId, actor: effect.caller, occurredAt: new Date().toISOString(), attemptId,
        taskId: String(attempt.task_id), requestId: effectId, payload: { allocation: value } });
      this.storageEvent('request.succeeded', effect.caller, { allocation: value }, effectId);
      return value;
    });
  }

  async recordUncertainAcquisition(attemptId: string, effectId: string, executor: ClaimIdentity, evidence: JsonObject): Promise<Attempt> {
    text(attemptId); text(effectId); claimIdentity(executor);
    const expected = { ...executor }, proof = object(evidence);
    if (!Object.keys(proof).length) throw new TypeError('Uncertainty requires evidence');
    return this.write(() => {
      const effect = this.effect(effectId, 'claimed'), attempt = this.attemptRow(attemptId);
      if (effect.operation !== 'workspace.acquire' || effect.attemptId !== attemptId || attempt.allocation !== null) throw new StorageError('conflict', 'Uncertain acquisition identity mismatch');
      this.effectExecutor(effect, expected);
      this.changed(this.db.prepare("UPDATE requests SET state = 'uncertain', result = ?, revision = revision + 1 WHERE id = ? AND state = 'claimed' AND revision = ?")
        .run(json(proof), effectId, effect.revision));
      this.changed(this.db.prepare("UPDATE attempts SET lease_state = 'unknown', phase = 'needs_resolution', revision = revision + 1 WHERE id = ? AND allocation IS NULL AND revision = ?")
        .run(attemptId, Number(attempt.revision)));
      this.insertEvent({ sourceKey: `attempt.acquisition_uncertain:${attemptId}`, kind: 'attempt.acquisition_uncertain', payloadVersion: 1,
        correlationId: effectId, actor: effect.caller, occurredAt: new Date().toISOString(), attemptId,
        taskId: String(attempt.task_id), requestId: effectId, payload: { evidence: proof } });
      this.storageEvent('request.uncertain', effect.caller, { evidence: proof }, effectId);
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  /** Recheck reserved inputs and readiness under the same lock as the start event. */
  async startAttempt(attemptId: string, caller: TaskActor): Promise<Attempt> {
    text(attemptId); taskActor(caller);
    const actor = object(caller);
    return this.write(() => {
      const attempt = this.attemptRow(attemptId), taskId = String(attempt.task_id);
      if (attempt.phase !== 'allocated' || attempt.launch_state !== 'pending' || attempt.lease_state !== 'held'
        || attempt.allocation === null) throw new StorageError('conflict', 'Attempt is not allocated');
      const spec = object(JSON.parse(String(attempt.specification))), workspace = object(spec.workspace);
      const allocation = object(JSON.parse(String(attempt.allocation))) as Allocation;
      allocationInput(allocation);
      if (allocation.leaseId !== attempt.lease_id || json(allocation.holder) !== json(workspace.holder)
        || allocation.pool !== workspace.pool || !inside(allocation.path, allocation.pool) || allocation.path === allocation.pool
        || json(allocation.repository) !== json(spec.repository) || allocation.outputRef !== spec.outputRef
        || allocation.startingCommit !== spec.startingCommit) throw new StorageError('conflict', 'Allocation does not match specification');
      const task = this.taskRow(taskId);
      const reason = Number(task.definition_revision) !== spec.definitionRevision ? 'task_definition_changed'
        : task.state !== 'queued' || task.hold_reason !== null || this.db.prepare(`SELECT 1 FROM dependencies
          JOIN tasks AS blocker ON blocker.id = blocker_id WHERE task_id = ? AND blocker.state <> 'done' LIMIT 1`).get(taskId)
          ? 'task_readiness_changed' : null;
      if (reason) {
        this.changed(this.db.prepare(`UPDATE attempts SET phase = 'settled', execution_open = 0, outcome = 'held',
          launch_state = 'fenced', revision = revision + 1 WHERE id = ? AND phase = 'allocated' AND launch_state = 'pending'`).run(attemptId));
        if (Number(task.decision_revision) === spec.decisionRevision) {
          this.changed(this.db.prepare('UPDATE tasks SET hold_reason = ?, decision_revision = decision_revision + 1 WHERE id = ? AND decision_revision = ?')
            .run(reason, taskId, Number(task.decision_revision)));
        }
        this.insertEvent({ sourceKey: `attempt.start_refused:${attemptId}`, kind: 'attempt.start_refused', payloadVersion: 1,
          correlationId: attemptId, actor, occurredAt: new Date().toISOString(), attemptId, taskId, payload: { reason } });
      } else {
        this.changed(this.db.prepare(`UPDATE attempts SET phase = 'running', started_decision_revision = ?, revision = revision + 1
          WHERE id = ? AND phase = 'allocated' AND launch_state = 'pending'`).run(Number(task.decision_revision), attemptId));
        this.changed(this.db.prepare("UPDATE tasks SET state = 'in_flight' WHERE id = ? AND state = 'queued'").run(taskId));
        this.insertEvent({ sourceKey: `attempt.started:${attemptId}`, kind: 'attempt.started', payloadVersion: 1,
          correlationId: attemptId, actor, occurredAt: new Date().toISOString(), attemptId, taskId,
          payload: { decisionRevision: Number(task.decision_revision) } });
      }
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  private dispatchCommand(attemptId: string): StoredRequest {
    const row = this.db.prepare("SELECT * FROM requests WHERE attempt_id = ? AND category = 'command' AND operation = 'attempt.dispatch'").get(attemptId);
    if (!row) throw new StorageError('conflict', 'Dispatch command is missing');
    return this.decodeRequest(row);
  }

  private workerEffect(attemptId: string, claimId: string, generation: string, operation: string, input: JsonObject, reference: JsonObject): StoredRequest {
    const command = this.dispatchCommand(attemptId);
    return this.recordEffectInTransaction({ requestKey: `${operation}:${attemptId}`, operation, parentId: command.id,
      attemptId, caller: command.caller, executor: { claimId, generation }, input,
      fingerprint: createHash('sha256').update(json(input)).digest('hex'), target: { kind: 'worker', reference } });
  }

  /** Existing intent is inspection evidence, never permission to prepare twice. */
  async beginWorkerPreparation(attemptId: string, claimId: string, host: WorkerHost): Promise<{ effect: StoredRequest; claimed: boolean }> {
    text(attemptId); text(claimId); workerHost(host);
    const owner = object(host) as WorkerHost;
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      this.workerClaim(attemptId, claimId, owner);
      const existing = this.db.prepare("SELECT * FROM requests WHERE attempt_id = ? AND operation = 'worker.prepare'").get(attemptId);
      if (existing) return { effect: this.decodeRequest(existing), claimed: false };
      if (attempt.phase !== 'running' || attempt.launch_state !== 'pending' || attempt.runtime_ref !== null) {
        throw new StorageError('conflict', 'Attempt is not awaiting preparation');
      }
      const spec = object(JSON.parse(String(attempt.specification)));
      const input = { databaseId: spec.databaseId!, contextId: spec.contextId!, taskId: spec.taskId!, attemptId,
        specification: spec, allocation: JSON.parse(String(attempt.allocation)), sessionId: randomUUID(), resultPath: spec.resultPath!,
        profileDigest: createHash('sha256').update(json(spec.profile)).digest('hex'),
        owner: { claimId, generation: owner.generation } };
      const effect = this.workerEffect(attemptId, claimId, owner.generation, 'worker.prepare', input, { launcher: object(spec.profile).launcher! });
      return { effect: this.claimEffectInTransaction(effect.id, { claimId, generation: owner.generation }), claimed: true };
    });
  }

  private workerClaim(attemptId: string, claimId: string, host: WorkerHost): void {
    const claim = this.activeClaim({ claimId, generation: host.generation });
    if (claim.attemptId !== attemptId || claim.resourceKey !== `worker:${attemptId}`
      || claim.role !== 'worker_owner' || json(claim.ownerRef) !== json(host)) {
      throw new StorageError('conflict', 'Worker owner claim does not match the attempt and host');
    }
  }

  private launchEvent(attemptId: string, taskId: string, host: WorkerHost, kind: string, payload: JsonObject): void {
    this.insertEvent({ sourceKey: `${kind}:${attemptId}`, kind, payloadVersion: 1,
      correlationId: attemptId, actor: host, occurredAt: new Date().toISOString(),
      attemptId, taskId, payload });
  }

  /** Register the one worker owner before asking the launcher to prepare a worker. */
  async registerWorkerOwner(attemptId: string, host: WorkerHost): Promise<string> {
    nonblank(attemptId); workerHost(host);
    const caller = object(host) as WorkerHost;
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      const existing = this.db.prepare('SELECT id FROM claims WHERE resource_key = ? AND released_at IS NULL')
        .get(`worker:${attemptId}`);
      if (existing) {
        this.workerClaim(attemptId, String(existing.id), caller);
        return String(existing.id);
      }
      if (attempt.phase !== 'running' || attempt.launch_state !== 'pending'
        || attempt.allocation === null || attempt.lease_state !== 'held') {
        throw new StorageError('conflict', 'Attempt has not started for worker ownership');
      }
      const [claim] = this.registerClaimsInTransaction([{ resourceKey: `worker:${attemptId}`, role: 'worker_owner',
        attemptId, generation: caller.generation, ownerRef: caller, schemaFamily: applicationId,
        schemaVersion, configRevision: this.configRevision(), heartbeatAt: new Date().toISOString() }], caller);
      const claimId = claim!.id;
      this.launchEvent(attemptId, String(attempt.task_id), caller, 'attempt.owner_registered', { claimId });
      return claimId;
    });
  }

  /** Refresh ownership, never launch permission. */
  async heartbeatWorkerOwner(attemptId: string, claimId: string, host: WorkerHost): Promise<void> {
    nonblank(attemptId); nonblank(claimId); workerHost(host);
    const caller = object(host) as WorkerHost;
    await this.write(() => {
      this.workerClaim(attemptId, claimId, caller);
      this.refreshClaimInTransaction({ claimId, generation: caller.generation }, new Date().toISOString(), caller);
    });
  }

  /** Bind a prepared worker before its first prompt, confirming its preparation effect. */
  async bindWorkerReference(attemptId: string, claimId: string, reference: WorkerReference, host: WorkerHost): Promise<WorkerReference> {
    nonblank(attemptId); nonblank(claimId); workerReference(reference); workerHost(host);
    const bound = object(reference) as WorkerReference;
    const caller = object(host) as WorkerHost;
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      if (attempt.runtime_ref !== null) {
        if (attempt.owner_claim_id === claimId && json(JSON.parse(String(attempt.runtime_ref))) === json(bound)) return bound;
        throw new StorageError('conflict', 'Attempt is bound to another worker');
      }
      if (attempt.phase !== 'running' || attempt.launch_state !== 'pending'
        || attempt.allocation === null || attempt.lease_state !== 'held'
        || attempt.owner_claim_id !== null) throw new StorageError('conflict', 'Attempt is not ready for worker binding');
      this.workerClaim(attemptId, claimId, caller);
      const spec = object(JSON.parse(String(attempt.specification)));
      if (object(spec.profile).launcher !== bound.launcher) throw new StorageError('conflict', 'Worker launcher differs from profile');
      const used = this.db.prepare('SELECT id FROM attempts WHERE runtime_ref = ?').get(json(bound));
      if (used) throw new StorageError('conflict', 'Worker is bound to another attempt');
      const prepare = this.db.prepare("SELECT id FROM requests WHERE attempt_id = ? AND operation = 'worker.prepare'").get(attemptId);
      if (!prepare) throw new StorageError('conflict', 'Preparation effect is missing');
      this.recordEffectOutcomeInTransaction(String(prepare.id), { claimId, generation: caller.generation }, 'succeeded', { reference: bound });
      this.changed(this.db.prepare(`UPDATE attempts SET runtime_ref = ?, owner_claim_id = ?, revision = revision + 1
        WHERE id = ? AND runtime_ref IS NULL AND owner_claim_id IS NULL AND launch_state = 'pending'`)
        .run(json(bound), claimId, attemptId));
      this.launchEvent(attemptId, String(attempt.task_id), caller, 'attempt.worker_bound', { claimId, reference: bound });
      return bound;
    });
  }

  /** Commit one launch-or-fence decision; permission creates one pending activation effect. */
  async decideWorkerLaunch(attemptId: string, claimId: string, decision: 'permit' | 'fence', host: WorkerHost): Promise<LaunchDecision> {
    nonblank(attemptId); nonblank(claimId); workerHost(host);
    if (decision !== 'permit' && decision !== 'fence') throw new TypeError('Invalid launch decision');
    const caller = object(host) as WorkerHost;
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      if (attempt.owner_claim_id !== null && attempt.owner_claim_id !== claimId) throw new StorageError('conflict', 'Attempt belongs to another owner claim');
      this.workerClaim(attemptId, claimId, caller);
      if (attempt.launch_state !== 'pending') throw new StorageError('conflict', 'Launch decision is final');
      if (attempt.phase !== 'running' || attempt.allocation === null || attempt.lease_state !== 'held') {
        throw new StorageError('conflict', 'Attempt has not started');
      }
      const taskId = String(attempt.task_id);
      if (decision === 'fence') {
        this.changed(this.db.prepare("UPDATE attempts SET launch_state = 'fenced', revision = revision + 1 WHERE id = ? AND launch_state = 'pending'").run(attemptId));
        this.launchEvent(attemptId, taskId, caller, 'attempt.launch_fenced', { claimId });
        return { state: 'fenced', changed: true, effectId: null };
      }
      if (attempt.runtime_ref === null || attempt.owner_claim_id !== claimId) {
        throw new StorageError('conflict', 'Worker reference must be bound before launch permission');
      }
      const reference = object(JSON.parse(String(attempt.runtime_ref))) as WorkerReference;
      workerReference(reference);
      const specification = object(JSON.parse(String(attempt.specification)));
      const effectId = this.workerEffect(attemptId, claimId, caller.generation, 'worker.activate', { specification }, reference).id;
      this.changed(this.db.prepare("UPDATE attempts SET launch_state = 'permitted', revision = revision + 1 WHERE id = ? AND launch_state = 'pending'").run(attemptId));
      this.launchEvent(attemptId, taskId, caller, 'attempt.launch_permitted', { claimId, reference, effectId });
      return { state: 'permitted', changed: true, effectId };
    });
  }

  /** A hook claims the activation effect before returning proceed; a lost reply stays uncertain. */
  async admitInitialBbPrompt(attemptId: string, threadId: string, host: WorkerHost): Promise<InitialPromptAdmission> {
    nonblank(attemptId); nonblank(threadId); workerHost(host);
    const reference = this.snapshot(() => {
      const attempt = this.attemptRow(attemptId);
      if (attempt.runtime_ref === null) return { launcher: 'bb', threadId };
      const bound = object(JSON.parse(String(attempt.runtime_ref))) as WorkerReference;
      if (bound.launcher !== 'bb' || bound.threadId !== threadId) throw new StorageError('conflict', 'Prompt thread does not match the bound worker');
      return bound;
    });
    return this.claimWorkerActivation(attemptId, reference, host);
  }

  async claimWorkerActivation(attemptId: string, reference: WorkerReference, host: WorkerHost): Promise<InitialPromptAdmission> {
    nonblank(attemptId); workerReference(reference); workerHost(host);
    const caller = object(host) as WorkerHost, bound = object(reference);
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      if (attempt.launch_state === 'fenced') return { kind: 'fenced' };
      if (attempt.launch_state === 'pending') return { kind: 'pending' };
      if (json(JSON.parse(String(attempt.runtime_ref))) !== json(bound)) throw new StorageError('conflict', 'Activation reference does not match the bound worker');
      this.workerClaim(attemptId, String(attempt.owner_claim_id), caller);
      const effect = this.db.prepare("SELECT * FROM requests WHERE attempt_id = ? AND operation = 'worker.activate'").get(attemptId);
      if (!effect) throw new StorageError('conflict', 'Activation effect is missing');
      if (effect.state !== 'pending') return { kind: 'already_admitted' };
      this.claimEffectInTransaction(String(effect.id), { claimId: String(attempt.owner_claim_id), generation: caller.generation });
      this.launchEvent(attemptId, String(attempt.task_id), caller, 'attempt.prompt_admitted', { effectId: String(effect.id), reference: bound });
      return { kind: 'admitted', effectId: String(effect.id) };
    });
  }

  /** Recovery may close pending admission without adopting its worker or refreshing its owner. */
  async fencePendingLaunch(attemptId: string, caller: TaskActor): Promise<void> {
    text(attemptId); taskActor(caller);
    if (caller.kind !== 'person') throw new StorageError('conflict', 'Recovery fencing requires a person');
    const actor = object(caller);
    await this.write(() => {
      const attempt = this.attemptRow(attemptId);
      this.changed(this.db.prepare("UPDATE attempts SET launch_state = 'fenced', revision = revision + 1 WHERE id = ? AND launch_state = 'pending'").run(attemptId));
      this.insertEvent({ sourceKey: `attempt.launch_fenced:${attemptId}`, kind: 'attempt.launch_fenced', payloadVersion: 1,
        correlationId: attemptId, actor, occurredAt: new Date().toISOString(), attemptId,
        taskId: String(attempt.task_id), payload: { recovery: true } });
    });
  }

  /** Repeat immediately before calling the launcher. This read grants no retry permission. */
  checkWorkerEffect(effectId: string, identity: ClaimIdentity): StoredRequest {
    text(effectId); claimIdentity(identity);
    return this.snapshot(() => {
      const effect = this.effect(effectId, 'claimed');
      this.checkWorkerEffectInTransaction(effect, identity);
      return effect;
    });
  }

  private checkWorkerEffectInTransaction(effect: StoredRequest, identity: ClaimIdentity): void {
    const claim = this.effectExecutor(effect, identity);
    if (heartbeatStatus(claim.heartbeatAt, Date.now()) !== 'fresh') throw new StorageError('conflict', 'Executor heartbeat is not fresh');
    const blockers = this.readAdmissionBlockers(Date.now());
    if (blockers.length) throw new StorageError('conflict', `Admission blocked: ${json(blockers)}`);
    const attempt = this.attemptRow(effect.attemptId!);
    if (claim.resourceKey !== `worker:${attempt.id}` || claim.role !== 'worker_owner' || claim.attemptId !== attempt.id
      || attempt.phase !== 'running' || attempt.execution_open !== 1) throw new StorageError('conflict', 'Worker executor scope mismatch');
    if (effect.operation === 'worker.activate') {
      if (attempt.launch_state !== 'permitted' || attempt.owner_claim_id !== identity.claimId
        || attempt.runtime_ref === null || json(effect.target!.reference) !== json(JSON.parse(String(attempt.runtime_ref)))) {
        throw new StorageError('conflict', 'Worker activation is not permitted');
      }
    } else if (effect.operation !== 'worker.prepare' || attempt.launch_state !== 'pending' || attempt.runtime_ref !== null) {
      throw new StorageError('conflict', 'Worker preparation is not permitted');
    }
  }

  private resultBindingInTransaction(attemptId: string): ResultBinding {
    const attempt = this.attemptRow(attemptId);
    const spec = object(JSON.parse(String(attempt.specification)));
    const preparation = this.db.prepare("SELECT * FROM requests WHERE attempt_id = ? AND operation = 'worker.prepare'").get(attemptId);
    if (!preparation || attempt.runtime_ref === null || attempt.lease_id === null || attempt.started_decision_revision === null) {
      throw new StorageError('result_identity_mismatch', 'Result requires a bound, started worker and allocation');
    }
    const input = this.decodeRequest(preparation).input;
    return { identity: { databaseId: spec.databaseId!, contextId: spec.contextId!, taskId: spec.taskId!,
      attemptId, leaseId: String(attempt.lease_id), sessionId: input.sessionId! },
      startingCommit: String(spec.startingCommit), outputRef: String(spec.outputRef), criteria: spec.criteria as string[],
      delivery: object(spec.delivery), resultPath: String(input.resultPath),
      recyclableRoots: [...new Set([...this.recyclableRoots, String(object(spec.workspace).pool)])] };
  }

  workerResultBinding(attemptId: string): ResultBinding {
    text(attemptId);
    return this.snapshot(() => this.resultBindingInTransaction(attemptId));
  }

  private validatedResultInTransaction(attemptId: string): ValidatedResult | null {
    const row = this.db.prepare("SELECT * FROM events WHERE source_key = ?").get(`attempt.result_validated:${attemptId}`);
    return row ? this.decodeEvent(row).payload as ValidatedResult : null;
  }

  validatedWorkerResult(attemptId: string): ValidatedResult | null {
    text(attemptId);
    return this.snapshot(() => { this.attemptRow(attemptId); return this.validatedResultInTransaction(attemptId); });
  }

  /** The source and retained artefacts are checked even after validation. Evidence is never replaced. */
  async validateWorkerResult(attemptId: string, host: WorkerHost,
    repository?: Pick<GitRepository, 'compare' | 'verifyRetention'>): Promise<ValidatedResult> {
    text(attemptId); workerHost(host);
    const actor = object(host) as WorkerHost;
    const binding = this.workerResultBinding(attemptId), previous = this.validatedWorkerResult(attemptId);
    let value: ValidatedResult;
    try {
      value = await readWorkerResult(binding);
      if (previous && (previous.digest !== value.digest || json(previous.artefacts) !== json(value.artefacts))) {
        throw new StorageError('result_discrepancy', 'Validated result or retained artefacts changed');
      }
    } catch (error) {
      if (previous) throw new StorageError('result_discrepancy', `Validated result is missing or changed: ${String(error)}`);
      throw error;
    }
    if (!previous && value.content.outcome === 'completed' && binding.delivery.kind === 'code') {
      if (!repository) throw new StorageError('result_invalid', 'Code result needs repository retention and ancestry evidence');
      const reference = (value.content.workReferences as JsonObject[]).find(item => item.kind === 'git')!;
      const comparison = await repository.compare(binding.startingCommit, String(reference.commit));
      if (comparison.status !== 'confirmed' || !comparison.value) throw new StorageError('result_invalid', 'Code candidate must descend from the starting commit');
      const retained = await repository.verifyRetention({ references: [{ ref: binding.outputRef, commit: String(reference.commit) }],
        artefacts: [], recyclableRoots: binding.recyclableRoots });
      if (retained.status !== 'confirmed') throw new StorageError('result_invalid', 'Exact candidate is not known to be retained');
    }
    return this.write(() => {
      const attempt = this.attemptRow(attemptId);
      this.workerClaim(attemptId, String(attempt.owner_claim_id), actor);
      if (json(binding) !== json(this.resultBindingInTransaction(attemptId))) throw new StorageError('result_identity_mismatch', 'Result binding changed');
      const recorded = this.validatedResultInTransaction(attemptId);
      if (recorded) {
        if (recorded.digest !== value.digest || json(recorded.artefacts) !== json(value.artefacts)) throw new StorageError('result_discrepancy', 'Validated result changed');
        return recorded;
      }
      this.launchEvent(attemptId, String(attempt.task_id), actor, 'attempt.result_validated', value);
      return value;
    });
  }

  /** Old source sequences still carry independent facts. A duplicate cannot erase terminal evidence. */
  async recordWorkerObservation(observation: WorkerObservation, host: WorkerHost): Promise<Attempt> {
    workerObservation(observation); workerHost(host);
    const value = object(observation) as WorkerObservation, actor = object(host) as WorkerHost;
    return this.write(() => {
      const attempt = this.attemptRow(value.attemptId);
      this.workerClaim(value.attemptId, String(attempt.owner_claim_id), actor);
      if (attempt.runtime_ref === null || json(JSON.parse(String(attempt.runtime_ref))) !== json(value.workerRef)) {
        throw new StorageError('result_identity_mismatch', 'Observation worker does not match the attempt');
      }
      this.insertEvent({ sourceKey: `worker.observation:${json([value.attemptId, value.sourceId, value.sourceSequence])}`,
        kind: 'worker.observed', payloadVersion: 1, correlationId: value.attemptId, actor,
        occurredAt: value.observedAt, attemptId: value.attemptId, taskId: String(attempt.task_id), payload: value });
      return this.decodeAttempt(attempt);
    });
  }

  /** No acceptance, integration, lease return or process-stop confirmation is implied. */
  async completeWorker(attemptId: string, host: WorkerHost,
    repository?: Pick<GitRepository, 'compare' | 'verifyRetention'>): Promise<Attempt> {
    text(attemptId); workerHost(host);
    const actor = object(host) as WorkerHost;
    const terminal = this.snapshot(() => this.db.prepare(`SELECT 1 FROM events WHERE attempt_id = ?
      AND kind = 'worker.observed' AND json_extract(payload, '$.kind') = 'terminal' LIMIT 1`).get(attemptId));
    if (!terminal) return this.attempt(attemptId);
    await this.validateWorkerResult(attemptId, actor, repository);
    return this.write(() => {
      const attempt = this.attemptRow(attemptId), taskId = String(attempt.task_id);
      this.workerClaim(attemptId, String(attempt.owner_claim_id), actor);
      if (attempt.outcome !== null) return this.decodeAttempt(attempt);
      const result = this.validatedResultInTransaction(attemptId)!;
      const spec = object(JSON.parse(String(attempt.specification))), delivery = object(spec.delivery);
      const outcome = String(result.content.outcome);
      const reference = (result.content.workReferences as JsonObject[]).find(item => item.kind === 'git');
      const candidate = outcome === 'completed' && delivery.kind === 'code'
        ? { id: randomUUID(), commit: reference!.commit!, outputRef: spec.outputRef!, resultDigest: result.digest } : null;
      const now = new Date().toISOString();
      this.changed(this.db.prepare(`UPDATE attempts SET candidate = ?, outcome = ?, phase = 'settled', execution_open = 0,
        settled_at = ?, revision = revision + 1 WHERE id = ? AND outcome IS NULL AND revision = ?`)
        .run(candidate === null ? null : json(candidate), outcome, now, attemptId, Number(attempt.revision)));
      const task = this.taskRow(taskId);
      // Person decision revisions, including a reopen, always win over this automated outcome.
      if (task.decision_revision === attempt.started_decision_revision) {
        const done = outcome === 'completed' && delivery.kind === 'report';
        this.changed(this.db.prepare('UPDATE tasks SET state = ?, hold_reason = ? WHERE id = ? AND decision_revision = ?')
          .run(done ? 'done' : 'queued', done ? null : candidate ? 'awaiting_acceptance' : `worker_${outcome}`,
            taskId, Number(task.decision_revision)));
      }
      this.launchEvent(attemptId, taskId, actor, 'attempt.completed', { outcome, candidate, resultDigest: result.digest });
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  /** Current person-controlled context additions; repository requirements are resolved by the adapter. */
  checkConfiguration(): { targetBranch: string; checks: ContextChecks; revision: number; digest: string } {
    return this.snapshot(() => this.checkConfigurationInTransaction());
  }

  private checkConfigurationInTransaction(): { targetBranch: string; checks: ContextChecks; revision: number; digest: string } {
    const row = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get();
    if (!row) throw new StorageError('conflict', 'Missing check configuration');
    const payload = this.decodeEvent(row).payload, resolved = object(payload.resolved);
    const finalisation = object(resolved.finalisation), checks = object(resolved.checks) as ContextChecks;
    text(finalisation.targetBranch);
    return { targetBranch: finalisation.targetBranch, checks, revision: Number(payload.revision), digest: String(payload.digest) };
  }

  /** Admission and slot ownership commit together. A lost executor never frees its slot by age. */
  async beginChecks(input: CheckRunInput): Promise<CheckAdmission> {
    taskActor(input.caller); text(input.attemptId);
    const value = JSON.parse(json(input)) as CheckRunInput;
    return this.write(() => {
      const attempt = this.attemptRow(value.attemptId), spec = object(JSON.parse(String(attempt.specification)));
      const result = this.validatedResultInTransaction(value.attemptId);
      const terminal = this.db.prepare(`SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'worker.observed'
        AND json_extract(payload, '$.kind') = 'terminal' LIMIT 1`).get(value.attemptId);
      const candidate = attempt.candidate === null ? null : object(JSON.parse(String(attempt.candidate)));
      if (!terminal || !result || candidate?.commit !== value.commit || attempt.allocation === null) {
        throw new StorageError('conflict', 'Checks require a terminal worker, validated result and recorded candidate');
      }
      const key = checkEvidenceKey(object(spec.repository), value.commit, spec.criteria as string[], value.checks, value.profile);
      const logical = { attemptId: value.attemptId, commit: value.commit, evidenceKey: key };
      const command: CommandInput = { requestKey: value.requestKey ?? `checks:auto:${value.attemptId}:${key}`,
        operation: 'checks.run', caller: value.caller, input: logical, fingerprint: json(logical) };
      let request = this.duplicateRequest(command, 'command');
      if (request && request.state !== 'pending') return { request, execute: false, executor: null };
      const config = this.checkConfigurationInTransaction();
      if ((value.expectedConfigRevision !== undefined && value.expectedConfigRevision !== config.revision)
        || (value.expectedConfigDigest !== undefined && value.expectedConfigDigest !== config.digest)) {
        throw new StorageError('conflict', 'Configuration changed while resolving check policy');
      }
      if (!request) {
        request = this.recordCommandInTransaction({ ...command, input: { ...logical, checks: value.checks, profile: value.profile } }, value.attemptId);
      }
      const previous = this.db.prepare(`SELECT * FROM requests WHERE operation = 'checks.run' AND id <> ?
        AND json_extract(input, '$.evidenceKey') = ? AND state IN ('succeeded', 'rejected') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(request.id, key);
      if (previous && (previous.state === 'succeeded' || value.requestKey === undefined)) {
        const reused = this.decodeRequest(previous);
        this.finishPendingCommandInTransaction(request.id, reused.state as 'succeeded' | 'rejected', reused.result!);
        this.storageEvent('checks.reused', value.caller, { evidenceKey: key, sourceRequestId: reused.id, attemptId: value.attemptId }, request.id);
        this.applyCheckOutcome(value.attemptId, reused.result as CheckRunResult);
        return { request: this.decodeRequest(this.requestRow(request.id)), execute: false, executor: null };
      }
      // A run of this identity already in flight must not be duplicated, even with a new request.
      const inFlight = this.db.prepare(`SELECT 1 FROM requests WHERE operation = 'checks.run' AND id <> ?
        AND json_extract(input, '$.evidenceKey') = ? AND state IN ('claimed', 'uncertain')`).get(request.id, key);
      const configured = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get()!;
      const resolved = object(this.decodeEvent(configured).payload.resolved), limits = object(resolved.limits);
      const maximum = Number(limits.maxConcurrentFullChecks ?? 1);
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid full-check capacity');
      const active = Number(this.db.prepare("SELECT count(*) AS n FROM claims WHERE role = 'check_executor' AND released_at IS NULL").get()!.n);
      if (inFlight || active >= maximum) {
        this.db.prepare("UPDATE attempts SET phase = 'awaiting_checks', revision = revision + 1 WHERE id = ?").run(value.attemptId);
        this.storageEvent('checks.waiting', value.caller, { attemptId: value.attemptId, evidenceKey: key }, request.id);
        return { request, execute: false, executor: null };
      }
      const generation = randomUUID();
      const [claim] = this.registerClaimsInTransaction([{ resourceKey: `checks:${request.id}`, role: 'check_executor',
        attemptId: value.attemptId, generation, ownerRef: object(value.caller), schemaFamily: applicationId,
        schemaVersion, configRevision: this.configRevision(), heartbeatAt: new Date().toISOString() }], value.caller);
      const claimed = this.claimCommandInTransaction(request.id, { claimId: claim!.id, generation });
      this.db.prepare("UPDATE attempts SET phase = 'awaiting_checks', revision = revision + 1 WHERE id = ?").run(value.attemptId);
      this.storageEvent('checks.started', value.caller, { attemptId: value.attemptId, evidenceKey: key }, request.id);
      return { request: claimed, execute: true, executor: { claimId: claim!.id, generation } };
    });
  }

  private applyCheckOutcome(attemptId: string, result: CheckRunResult): void {
    const attempt = this.attemptRow(attemptId), task = this.taskRow(String(attempt.task_id));
    this.db.prepare('UPDATE attempts SET phase = ?, revision = revision + 1 WHERE id = ?')
      .run(result.status === 'uncertain' ? 'needs_resolution' : 'settled', attemptId);
    if (task.decision_revision === attempt.started_decision_revision) {
      this.db.prepare('UPDATE tasks SET hold_reason = ? WHERE id = ? AND decision_revision = ?')
        .run(result.status === 'passed' ? 'awaiting_acceptance' : result.status === 'failed' ? 'checks_failed' : 'checks_uncertain',
          String(attempt.task_id), Number(task.decision_revision));
    }
  }

  async finishChecks(requestId: string, executor: ClaimIdentity, result: CheckRunResult): Promise<StoredRequest> {
    claimIdentity(executor);
    const value = JSON.parse(json(object(result))) as CheckRunResult;
    if (!['passed', 'failed', 'uncertain'].includes(value.status)) throw new TypeError('Invalid check outcome');
    return this.write(() => {
      const request = this.decodeRequest(this.requestRow(requestId)), claim = this.activeClaim(executor);
      if (request.operation !== 'checks.run' || request.state !== 'claimed' || request.claimId !== claim.id
        || request.input.evidenceKey !== value.evidenceKey) throw new StorageError('conflict', 'Check executor or evidence mismatch');
      if (value.status === 'passed') {
        const checks = object(request.input.checks);
        const expected = [...(checks.fast as JsonObject[]).map(definition => ({ kind: 'fast', definition })),
          ...(checks.full as JsonObject[]).map(definition => ({ kind: 'full', definition }))];
        if (!Array.isArray(value.commands) || value.commands.length !== expected.length
          || expected.some((check, index) => {
            const command = value.commands[index]!;
            return command.kind !== check.kind || json(command.definition) !== json(check.definition)
              || command.status !== 'passed' || command.exitCode !== 0 || command.timedOut !== false;
          })) throw new StorageError('conflict', 'A pass requires every mandatory command to have passed');
      }
      const state = value.status === 'passed' ? 'succeeded' : value.status === 'failed' ? 'rejected' : 'uncertain';
      this.db.prepare('UPDATE requests SET state = ?, result = ?, revision = revision + 1 WHERE id = ?').run(state, json(value), requestId);
      if (value.status !== 'uncertain') {
        this.db.prepare('UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1 WHERE id = ?')
          .run(new Date().toISOString(), json({ requestId, status: value.status }), claim.id);
      }
      this.applyCheckOutcome(request.attemptId!, value);
      this.storageEvent('checks.finished', request.caller, { attemptId: request.attemptId!, ...value }, requestId);
      return this.decodeRequest(this.requestRow(requestId));
    });
  }

  finalisationConfiguration(): { policy: JsonObject; revision: number; digest: string } {
    return this.snapshot(() => {
      const row = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get()!;
      const payload = this.decodeEvent(row).payload;
      return { policy: object(object(payload.resolved).finalisation), revision: Number(payload.revision), digest: String(payload.digest) };
    });
  }

  private completionGuard(attemptId: string): Record<string, unknown> {
    const attempt = this.attemptRow(attemptId);
    const terminal = this.db.prepare(`SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'worker.observed'
      AND json_extract(payload, '$.kind') = 'terminal' LIMIT 1`).get(attemptId);
    if (!terminal || attempt.execution_open !== 0 || attempt.outcome === null || attempt.allocation === null) {
      throw new StorageError('conflict', 'Completion requires a stopped terminal worker, recorded outcome and allocation');
    }
    return attempt;
  }

  private completionEvent(key: string, kind: string, attemptId: string, caller: TaskActor, payload: JsonObject, requestId: string): void {
    this.insertEvent({ sourceKey: key, kind, payloadVersion: 1, correlationId: requestId, requestId,
      attemptId, taskId: String(this.attemptRow(attemptId).task_id), actor: caller,
      occurredAt: new Date().toISOString(), payload });
  }

  async authoriseRebase(attemptId: string, requestId: string, caller: TaskActor, plan: JsonObject): Promise<StoredEvent> {
    taskActor(caller);
    return this.write(() => {
      const key = `rebase.authorised:${requestId}`;
      const existing = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key);
      if (existing) return this.decodeEvent(existing);
      const attempt = this.completionGuard(attemptId);
      if (attempt.lease_state !== 'held' || attempt.candidate === null
        || this.db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'candidate.accepted'").get(attemptId)) throw new StorageError('conflict', 'Rebase requires an unaccepted candidate and held lease');
      if (this.db.prepare(`SELECT 1 FROM requests WHERE attempt_id = ? AND state IN ('pending','claimed','uncertain')
        AND (category = 'effect' OR operation = 'checks.run') LIMIT 1`).get(attemptId)) throw new StorageError('conflict', 'Attempt has an unresolved effect');
      const command = this.decodeRequest(this.requestRow(requestId));
      if (command.operation !== 'attempt.rebase' || command.input.attemptId !== attemptId || json(command.caller) !== json(caller)) throw new StorageError('conflict', 'Wrong rebase command');
      const candidate = object(JSON.parse(String(attempt.candidate)));
      if (candidate.commit !== plan.original || candidate.id !== plan.candidateId) throw new StorageError('conflict', 'Exact candidate changed');
      this.completionEvent(key, 'rebase.authorised', attemptId, caller, plan, requestId);
      return this.decodeEvent(this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key)!);
    });
  }

  async finishRebase(authorisation: StoredEvent, commit: string): Promise<Attempt> {
    return this.write(() => {
      const key = `output.rebased:${authorisation.id}`;
      if (this.db.prepare('SELECT 1 FROM events WHERE source_key = ?').get(key)) return this.decodeAttempt(this.attemptRow(authorisation.attemptId!));
      const attemptId = authorisation.attemptId!, attempt = this.completionGuard(attemptId);
      for (const operation of ['pin', 'rebase', 'move', 'attach']) {
        const effect = this.db.prepare('SELECT * FROM requests WHERE request_key = ?').get(`${operation}:${attemptId}:${authorisation.id}`);
        if (!effect || effect.state !== 'succeeded') throw new StorageError('conflict', 'Rebase effect is unresolved');
        if (operation === 'move' && object(JSON.parse(String(effect.input))).commit !== commit) throw new StorageError('conflict', 'Rebased commit changed');
      }
      const previous = object(JSON.parse(String(attempt.candidate)));
      if (attempt.lease_state !== 'held' || this.db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'candidate.accepted'").get(attemptId)) throw new StorageError('conflict', 'Rebase candidate already accepted or lease returned');
      if (previous.id !== authorisation.payload.candidateId) throw new StorageError('conflict', 'Exact candidate changed');
      const candidate = { ...previous, id: randomUUID(), commit, selectedBy: authorisation.actor };
      this.db.prepare('UPDATE attempts SET candidate = ?, revision = revision + 1 WHERE id = ?').run(json(candidate), attemptId);
      this.completionEvent(key, 'output.rebased', attemptId, authorisation.actor as unknown as TaskActor,
        { ...authorisation.payload, attemptId, candidate, rebased: commit }, authorisation.requestId!);
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  async selectRetainedCandidate(attemptId: string, commit: string, outputRef: string, caller: TaskActor): Promise<Attempt> {
    taskActor(caller); text(commit); text(outputRef);
    return this.write(() => {
      const attempt = this.completionGuard(attemptId), spec = object(JSON.parse(String(attempt.specification)));
      if (object(spec.delivery).kind !== 'code' || outputRef !== spec.outputRef || commit === spec.startingCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new StorageError('conflict', 'Candidate must name the retained output and move beyond the start');
      if (this.db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'candidate.accepted'").get(attemptId)) throw new StorageError('conflict', 'An accepted candidate cannot be replaced');
      const previous = attempt.candidate === null ? null : object(JSON.parse(String(attempt.candidate)));
      if (previous?.commit === commit && previous.outputRef === outputRef) return this.decodeAttempt(attempt);
      const result = this.validatedResultInTransaction(attemptId);
      if (!result) throw new StorageError('conflict', 'Candidate requires a validated result');
      const candidate = { id: randomUUID(), commit, outputRef, selectedBy: caller, resultDigest: result.digest };
      this.db.prepare('UPDATE attempts SET candidate = ?, revision = revision + 1 WHERE id = ?').run(json(candidate), attemptId);
      this.insertEvent({ sourceKey: `candidate.selected:${candidate.id}`, kind: 'candidate.selected', payloadVersion: 1,
        correlationId: attemptId, attemptId, taskId: String(attempt.task_id), actor: caller,
        occurredAt: new Date().toISOString(), payload: candidate });
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  acceptance(attemptId: string, candidateId: string): StoredEvent | null {
    return this.snapshot(() => {
      const row = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(`candidate.accepted:${attemptId}:${candidateId}`);
      return row ? this.decodeEvent(row) : null;
    });
  }

  /** The acceptance and its exact evidence scope commit together, before any integration. */
  async recordAcceptance(input: AcceptInput, requestId: string, plan: FinalisationPlan,
    checks: StoredRequest | null, config: { revision: number; digest: string }): Promise<StoredEvent> {
    taskActor(input.caller);
    const value = structuredClone(input), policy = object(plan);
    if (value.overrideReason !== undefined) nonblank(value.overrideReason);
    return this.write(() => {
      const attempt = this.completionGuard(value.attemptId), task = this.taskRow(String(attempt.task_id));
      const command = this.decodeRequest(this.requestRow(requestId));
      if (command.operation !== 'attempt.accept' || json(command.caller) !== json(value.caller)
        || json(command.input) !== json(value)) throw new StorageError('conflict', 'Acceptance must match its person command');
      const candidate = object(JSON.parse(String(attempt.candidate)));
      if (candidate.id !== value.candidateId || candidate.commit !== value.commit) throw new StorageError('conflict', 'Exact candidate changed');
      const key = `candidate.accepted:${value.attemptId}:${value.candidateId}`;
      const previous = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key);
      if (previous) return this.decodeEvent(previous);
      const current = this.checkConfigurationInTransaction();
      const configured = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get()!;
      const finalisation = object(object(this.decodeEvent(configured).payload.resolved).finalisation);
      const target = String(finalisation.targetBranch).startsWith('refs/') ? String(finalisation.targetBranch) : `refs/heads/${String(finalisation.targetBranch)}`;
      if (policy.kind !== finalisation.kind || policy.target !== target) throw new StorageError('conflict', 'Finalisation plan differs from configuration');
      if (current.revision !== config.revision || current.digest !== config.digest) throw new StorageError('conflict', 'Configuration changed before acceptance');
      const check = checks === null ? null : this.decodeRequest(this.requestRow(checks.id));
      if (!value.overrideReason && (!check || check.operation !== 'checks.run' || check.attemptId !== value.attemptId
        || check.input.commit !== value.commit || check.state !== 'succeeded' || check.result?.status !== 'passed')) {
        throw new StorageError('conflict', 'Acceptance requires passing checks or a person override reason');
      }
      if (this.db.prepare(`SELECT 1 FROM requests WHERE attempt_id = ? AND state IN ('claimed','uncertain')
        AND (category = 'effect' OR operation = 'checks.run') LIMIT 1`).get(value.attemptId)) {
        throw new StorageError('conflict', 'Attempt has an unresolved effect');
      }
      if (value.overrideReason) {
        const waiting = this.db.prepare("SELECT id FROM requests WHERE attempt_id = ? AND operation = 'checks.run' AND state = 'pending' AND json_extract(input, '$.commit') = ?")
          .all(value.attemptId, value.commit);
        for (const request of waiting) {
          const result = { reason: value.overrideReason, candidate, called: false };
          this.db.prepare("UPDATE requests SET state = 'withdrawn', result = ?, revision = revision + 1 WHERE id = ? AND state = 'pending'").run(json(result), String(request.id));
          this.storageEvent('checks.overridden', value.caller, result, String(request.id));
        }
      }
      this.completionEvent(key, 'candidate.accepted', value.attemptId, value.caller,
        { candidate, plan: policy, decisionRevision: Number(task.decision_revision),
          checksRequestId: check?.id ?? null, overrideReason: value.overrideReason ?? null }, requestId);
      return this.decodeEvent(this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key)!);
    });
  }

  async finishAcceptance(acceptance: StoredEvent): Promise<Attempt> {
    return this.write(() => {
      const stored = this.decodeEvent(this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(acceptance.sourceKey)!);
      const attemptId = stored.attemptId!, attempt = this.completionGuard(attemptId), task = this.taskRow(String(attempt.task_id));
      const candidate = object(stored.payload.candidate), plan = object(stored.payload.plan);
      if (json(candidate) !== json(JSON.parse(String(attempt.candidate)))) throw new StorageError('conflict', 'Accepted candidate changed');
      if (plan.kind === 'local-merge' && !this.db.prepare(`SELECT 1 FROM requests WHERE request_key = ? AND state = 'succeeded'`)
        .get(`integrate:${attemptId}:${String(candidate.id)}`)) throw new StorageError('conflict', 'Integration is not confirmed');
      const key = `acceptance.finished:${stored.id}`;
      if (!this.db.prepare('SELECT 1 FROM events WHERE source_key = ?').get(key)) {
        if (Number(task.decision_revision) === stored.payload.decisionRevision) {
          this.db.prepare("UPDATE tasks SET state = 'done', hold_reason = NULL WHERE id = ? AND decision_revision = ?")
            .run(String(attempt.task_id), Number(task.decision_revision));
        }
        this.completionEvent(key, 'acceptance.finished', attemptId, stored.actor as TaskActor, { candidate, integrated: plan.kind === 'local-merge' }, stored.requestId!);
      }
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  /** Return authorisation never implies a process-tree observation by a launcher. */
  async authoriseReturn(input: ReturnInput, requestId: string): Promise<StoredEvent> {
    taskActor(input.caller);
    const value = structuredClone(input);
    if (value.discard !== undefined) nonblank(value.discard.reason);
    return this.write(() => {
      const raw = this.attemptRow(value.attemptId);
      const abandonedWithoutOutcome = value.discard !== undefined && raw.outcome === null;
      const terminal = this.db.prepare(`SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'worker.observed'
        AND json_extract(payload, '$.kind') = 'terminal' LIMIT 1`).get(value.attemptId);
      if (abandonedWithoutOutcome && (!terminal || raw.allocation === null)) {
        throw new StorageError('conflict', 'Discard requires a stopped terminal worker and allocation');
      }
      const attempt = abandonedWithoutOutcome ? raw : this.completionGuard(value.attemptId);
      const allocation = object(JSON.parse(String(attempt.allocation)));
      const command = this.decodeRequest(this.requestRow(requestId));
      if (command.operation !== (value.discard ? 'attempt.discard' : 'attempt.return') || json(command.caller) !== json(value.caller)
        || json(command.input) !== json(value)) throw new StorageError('conflict', 'Return must match its person command');
      if (value.noProcesses?.leaseId !== allocation.leaseId || (value.discard !== undefined
        && (value.discard.leaseId !== allocation.leaseId || value.discard.confirmed !== true))) {
        throw new StorageError('conflict', 'Person confirmations must name the exact lease');
      }
      const key = `return.authorised:${value.attemptId}`;
      const previous = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key);
      if (previous) {
        const recorded = this.decodeEvent(previous);
        if (Boolean(recorded.payload.discard) !== Boolean(value.discard)) throw new StorageError('conflict', 'Return and discard decisions differ');
        return recorded;
      }
      if (this.db.prepare(`SELECT 1 FROM requests WHERE attempt_id = ? AND state IN ('pending','claimed','uncertain')
        AND (category = 'effect' OR operation = 'checks.run') LIMIT 1`).get(value.attemptId)) throw new StorageError('conflict', 'Attempt has an unresolved effect');
      if (abandonedWithoutOutcome) {
        this.db.prepare(`UPDATE attempts SET outcome = 'failed', execution_open = 0, phase = 'settled',
          settled_at = ?, revision = revision + 1 WHERE id = ? AND outcome IS NULL`)
          .run(new Date().toISOString(), value.attemptId);
        this.completionEvent(`attempt.discard_failed:${value.attemptId}`, 'attempt.completed', value.attemptId,
          value.caller, { outcome: 'failed', reason: value.discard!.reason, discardedWithoutResult: true }, requestId);
      }
      this.completionEvent(key, 'return.authorised', value.attemptId, value.caller,
        { allocation, discard: Boolean(value.discard), abandonedWithoutOutcome, discardReason: value.discard?.reason ?? null, noProcesses: value.noProcesses, decisionRevision: Number(this.taskRow(String(attempt.task_id)).decision_revision) }, requestId);
      return this.decodeEvent(this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(key)!);
    });
  }

  async finishReturn(authorisation: StoredEvent): Promise<Attempt> {
    return this.write(() => {
      const stored = this.decodeEvent(this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(authorisation.sourceKey)!);
      const attemptId = stored.attemptId!, attempt = this.completionGuard(attemptId);
      if (!this.db.prepare("SELECT 1 FROM requests WHERE request_key = ? AND state = 'succeeded'").get(`return:${attemptId}`)) {
        throw new StorageError('conflict', 'Lease return is not confirmed');
      }
      if (attempt.lease_state !== 'returned') {
        this.db.prepare("UPDATE attempts SET lease_state = 'returned', revision = revision + 1 WHERE id = ?").run(attemptId);
        const task = this.taskRow(String(attempt.task_id));
        if (stored.payload.discard && task.state !== 'done') {
          this.db.prepare("UPDATE tasks SET state = 'queued', hold_reason = 'discarded' WHERE id = ?").run(String(attempt.task_id));
        }
        this.completionEvent(`lease.returned:${attemptId}`, 'lease.returned', attemptId, stored.actor as TaskActor,
          { discard: stored.payload.discard!, allocation: stored.payload.allocation! }, stored.requestId!);
      }
      return this.decodeAttempt(this.attemptRow(attemptId));
    });
  }

  /** Reserve a single executor and immutable intent for a completion effect. */
  async beginCompletionEffect(authorisation: StoredEvent, operation: import('./rebase.ts').CompletionEffect, input: JsonObject): Promise<{ request: StoredRequest; executor: ClaimIdentity }> {
    const value = object(input);
    return this.write(() => {
      const storedRow = this.db.prepare('SELECT * FROM events WHERE source_key = ?').get(authorisation.sourceKey);
      if (!storedRow) throw new StorageError('conflict', 'Missing completion authorisation');
      const stored = this.decodeEvent(storedRow), attemptId = stored.attemptId!, attempt = this.completionGuard(attemptId);
      const rebasing = ['pin', 'rebase', 'move', 'attach'].includes(operation);
      const suffix = rebasing ? `:${stored.id}` : operation === 'integrate' ? `:${String(object(stored.payload.candidate).id)}` : '';
      const key = `${operation}:${attemptId}${suffix}`;
      const existing = this.db.prepare('SELECT * FROM requests WHERE request_key = ?').get(key);
      if (existing) {
        const request = this.decodeRequest(existing), claim = this.decodeClaim(this.claimRow(request.claimId!));
        if (json(request.input) !== json(value) || request.parentId !== stored.requestId) throw new StorageError('conflict', 'Completion effect input differs from authorisation');
        return { request, executor: { claimId: claim.id, generation: claim.generation } };
      }
      if ((rebasing && stored.kind !== 'rebase.authorised') || (operation === 'integrate' && stored.kind !== 'candidate.accepted') || (!rebasing && operation !== 'integrate' && stored.kind !== 'return.authorised')) throw new StorageError('conflict', 'Wrong completion authorisation');
      if (operation === 'integrate' && Number(this.taskRow(String(attempt.task_id)).decision_revision) !== stored.payload.decisionRevision) {
        throw new StorageError('conflict', 'A newer person decision prevents integration');
      }
      if (operation === 'integrate' && json(value) !== json({ ...object(stored.payload.plan), commit: object(stored.payload.candidate).commit })) throw new StorageError('conflict', 'Integration input differs from acceptance');
      if (operation === 'return' && json(value) !== json({ allocation: stored.payload.allocation })) throw new StorageError('conflict', 'Return input differs from authorisation');
      if (rebasing) {
        const plan = stored.payload;
        if (operation === 'pin' && json(value) !== json({ ref: plan.pinnedRef, commit: plan.pinnedCommit })) throw new StorageError('conflict', 'Pin differs from rebase authorisation');
        if (operation === 'rebase' && json(value) !== json({ original: plan.original, upstream: plan.upstream, target: plan.target, workspace: plan.workspace })) throw new StorageError('conflict', 'Rebase differs from authorisation');
        if (operation === 'move' || operation === 'attach') {
          const previous = this.db.prepare('SELECT * FROM requests WHERE request_key = ?').get(`rebase:${attemptId}:${stored.id}`);
          const result = previous ? this.decodeRequest(previous).result : null;
          const commit = result?.value ? object(result.value).commit : null;
          const expected = operation === 'move' ? { ref: plan.outputRef, original: plan.original, commit }
            : { ref: plan.outputRef, commit, workspace: plan.workspace };
          if (!previous || previous.state !== 'succeeded' || !commit || json(value) !== json(expected)) throw new StorageError('conflict', 'Output move differs from recorded rebase');
        }
        const candidate = object(JSON.parse(String(attempt.candidate)));
        if (candidate.id !== stored.payload.candidateId || attempt.lease_state !== 'held'
          || this.db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'candidate.accepted'").get(attemptId)) throw new StorageError('conflict', 'Rebase candidate changed or accepted');
      }
      if (operation === 'cleanup' || operation === 'cleanup-pin') {
        if (attempt.lease_state !== 'returned') throw new StorageError('conflict', 'Return must be confirmed before cleanup');
        const result = this.validatedResultInTransaction(attemptId);
        const reference = (result?.content.workReferences as JsonObject[] | undefined)?.find(item => item.kind === 'git');
        const candidate = attempt.candidate === null ? { outputRef: reference?.branch, commit: reference?.commit } : object(JSON.parse(String(attempt.candidate)));
        const pin = this.db.prepare("SELECT * FROM events WHERE attempt_id = ? AND kind = 'output.rebased' ORDER BY seq LIMIT 1").get(attemptId);
        const pinned = pin ? this.decodeEvent(pin).payload : null;
        const matches = operation === 'cleanup-pin' ? pinned && value.ref === pinned.pinnedRef && value.commit === pinned.pinnedCommit
          : candidate.commit && value.ref === candidate.outputRef && value.commit === candidate.commit;
        if (!matches) throw new StorageError('conflict', 'Cleanup does not name the recorded output');
        const integrated = this.db.prepare("SELECT 1 FROM requests WHERE attempt_id = ? AND operation = 'completion.integrate' AND state = 'succeeded' AND json_extract(input, '$.commit') = ?").get(attemptId, String(candidate.commit));
        if (!stored.payload.discard && !integrated) throw new StorageError('conflict', 'Output is neither integrated nor discarded');
      }
      if (this.db.prepare(`SELECT 1 FROM requests WHERE attempt_id = ? AND state IN ('pending','claimed','uncertain')
        AND (category = 'effect' OR operation = 'checks.run') LIMIT 1`).get(attemptId)) throw new StorageError('conflict', 'Attempt has an unresolved effect');
      const generation = randomUUID();
      const [claim] = this.registerClaimsInTransaction([{ resourceKey: `completion:${attemptId}`, role: 'maintenance', attemptId,
        generation, ownerRef: stored.actor, schemaFamily: applicationId, schemaVersion, configRevision: this.configRevision(), heartbeatAt: new Date().toISOString() }], stored.actor);
      const executor = { claimId: claim!.id, generation };
      const request = this.recordEffectInTransaction({ requestKey: key, operation: `completion.${operation}`, caller: stored.actor,
        input: value, fingerprint: json(value), parentId: stored.requestId!, executor, attemptId,
        target: { kind: ['return', 'rebase', 'attach'].includes(operation) ? 'workspace' : 'repository', reference: value } });
      return { request, executor };
    });
  }

  private checkCompletionEffectInTransaction(request: StoredRequest, executor: ClaimIdentity): void {
    const claim = this.effectExecutor(request, executor), attempt = this.completionGuard(request.attemptId!);
    if (heartbeatStatus(claim.heartbeatAt, Date.now()) !== 'fresh') throw new StorageError('conflict', 'Completion executor heartbeat is not fresh');
    if (this.db.prepare(`SELECT 1 FROM requests WHERE attempt_id = ? AND id <> ? AND state IN ('pending','claimed','uncertain')
      AND (category = 'effect' OR operation = 'checks.run') LIMIT 1`).get(request.attemptId!, request.id)) throw new StorageError('conflict', 'Attempt has another unresolved effect');
    if (['completion.pin', 'completion.rebase', 'completion.move', 'completion.attach'].includes(request.operation)) {
      const row = this.db.prepare("SELECT * FROM events WHERE request_id = ? AND kind = 'rebase.authorised'").get(request.parentId!);
      const candidate = attempt.candidate === null ? null : object(JSON.parse(String(attempt.candidate)));
      if (!row || candidate?.id !== this.decodeEvent(row).payload.candidateId || attempt.lease_state !== 'held'
        || this.db.prepare("SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'candidate.accepted'").get(request.attemptId!)) throw new StorageError('conflict', 'Rebase candidate changed or accepted');
    }
    if (request.operation === 'completion.integrate') {
      const accepted = this.db.prepare("SELECT * FROM events WHERE request_id = ? AND kind = 'candidate.accepted'").get(request.parentId!);
      if (!accepted || Number(this.taskRow(String(attempt.task_id)).decision_revision) !== this.decodeEvent(accepted).payload.decisionRevision) {
        throw new StorageError('conflict', 'A newer person decision prevents integration');
      }
    }
  }

  checkCompletionEffect(id: string, executor: ClaimIdentity): StoredRequest {
    claimIdentity(executor);
    return this.snapshot(() => {
      const request = this.effect(id, 'claimed');
      if (!request.operation.startsWith('completion.')) throw new StorageError('conflict', 'Not a completion effect');
      this.checkCompletionEffectInTransaction(request, executor);
      return request;
    });
  }

  /** Safe owner reads may settle a lost response; they never reopen permission to call. */
  async settleCompletionEffect(id: string, evidence: JsonObject): Promise<StoredRequest> {
    const proof = object(evidence);
    return this.write(() => {
      const request = this.decodeRequest(this.requestRow(id));
      if (!request.operation.startsWith('completion.') || !['claimed', 'uncertain'].includes(request.state) || proof.confirmed !== true) throw new StorageError('conflict', 'Completion effect is not reconcilable');
      if ((request.operation === 'completion.integrate' && (proof.target !== request.input.target || proof.commit !== request.input.commit))
        || (request.operation === 'completion.return' && proof.leaseId !== object(request.input.allocation).leaseId)
        || (['completion.cleanup', 'completion.cleanup-pin'].includes(request.operation) && proof.ref !== request.input.ref)) throw new StorageError('conflict', 'Reconciliation evidence has the wrong scope');
      this.db.prepare("UPDATE requests SET state = 'succeeded', result = ?, revision = revision + 1 WHERE id = ?").run(json(proof), id);
      this.db.prepare('UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1 WHERE id = ?')
        .run(new Date().toISOString(), json(proof), request.claimId!);
      this.storageEvent('completion.reconciled', request.caller, { evidence: proof }, id);
      return this.decodeRequest(this.requestRow(id));
    });
  }

  private configRevision(): number {
    const row = this.db.prepare("SELECT * FROM events WHERE kind = 'context.configured' ORDER BY seq DESC LIMIT 1").get();
    if (!row) throw new StorageError('conflict', 'Missing context configuration');
    const event = this.decodeEvent(row);
    if (event.payloadVersion !== 1 || !Number.isSafeInteger(event.payload.revision)) {
      throw new StorageError('version', 'Unsupported context configuration evidence');
    }
    return Number(event.payload.revision);
  }

  private claimRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
    if (!row) throw new StorageError('conflict', `Unknown claim: ${id}`);
    return row;
  }

  private decodeClaim(row: Record<string, unknown>): Claim {
    const claim: Claim = { id: String(row.id), resourceKey: String(row.resource_key), role: row.role as Claim['role'],
      generation: String(row.generation), ownerRef: object(JSON.parse(String(row.owner_ref))),
      schemaFamily: Number(row.schema_family), schemaVersion: Number(row.schema_version),
      configRevision: Number(row.config_revision), heartbeatAt: String(row.heartbeat_at), revision: Number(row.revision),
      releasedAt: row.released_at === null ? null : String(row.released_at),
      releaseEvidence: row.release_evidence === null ? null : object(JSON.parse(String(row.release_evidence))),
      ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
      ...(row.objective_id === null ? {} : { objectiveId: String(row.objective_id) }) };
    // An unreadable heartbeat must remain inspectable and block admission.
    const { id, revision, releasedAt, releaseEvidence, ...input } = claim;
    claimInput({ ...input, heartbeatAt: new Date(0).toISOString() });
    text(id);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid claim revision');
    return claim;
  }

  private validateScope(attemptId: string | undefined, objectiveId: string | undefined): void {
    if (attemptId !== undefined) {
      const attempt = this.db.prepare('SELECT objective_id FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt || attempt.objective_id !== (objectiveId ?? null)) {
        throw new StorageError('conflict', 'Attempt and objective scope do not match');
      }
    }
  }

  private compatibleClaim(claim: ClaimInput): void {
    if (claim.schemaFamily !== applicationId || claim.schemaVersion !== schemaVersion) {
      throw new StorageError('version', 'Claim schema family/version does not match this database');
    }
    if (claim.configRevision !== this.configRevision()) throw new StorageError('conflict', 'Claim configuration revision is stale');
  }

  private activeClaim(identity: ClaimIdentity): Claim {
    const claim = this.decodeClaim(this.claimRow(identity.claimId));
    if (claim.generation !== identity.generation || claim.releasedAt !== null) {
      throw new StorageError('conflict', 'Claim ID/generation is not an unreleased owner');
    }
    this.compatibleClaim(claim);
    return claim;
  }

  private storageEvent(kind: string, actor: JsonObject, payload: JsonObject, requestId?: string): void {
    const id = randomUUID();
    this.insertEvent({ sourceKey: `${kind}:${id}`, kind, payloadVersion: 1, correlationId: requestId ?? id,
      actor, occurredAt: new Date().toISOString(), payload, ...(requestId === undefined ? {} : { requestId }) });
  }

  /** All resource admissions are checked under the same write lock. No expiry takeover exists. */
  async registerClaims(inputs: readonly ClaimInput[], actor: JsonObject): Promise<Claim[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new TypeError('Expected one or more claims');
    inputs.forEach(claimInput);
    const values = JSON.parse(json(inputs)) as ClaimInput[], owner = object(actor);
    return this.write(() => this.registerClaimsInTransaction(values, owner));
  }

  /** Shared transaction bodies keep compound operations on the same claim/request rules. */
  private registerClaimsInTransaction(inputs: readonly ClaimInput[], actor: JsonObject): Claim[] {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new TypeError('Expected one or more claims');
    const values = inputs.map(input => {
      claimInput(input);
      return { ...JSON.parse(json(input)) as ClaimInput, ownerRef: object(input.ownerRef) };
    }).sort((a, b) => a.resourceKey < b.resourceKey ? -1 : a.resourceKey > b.resourceKey ? 1 : 0);
    if (new Set(values.map(value => value.resourceKey)).size !== values.length) throw new TypeError('Duplicate resource key');
    const owner = object(actor);
    return values.map(value => {
      this.compatibleClaim(value);
      this.validateScope(value.attemptId, value.objectiveId);
      if (this.db.prepare('SELECT 1 FROM claims WHERE resource_key = ? AND released_at IS NULL').get(value.resourceKey)) {
        throw new StorageError('conflict', `Resource has an unreleased claim: ${value.resourceKey}`);
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO claims (id, resource_key, role, attempt_id, objective_id, generation,
        owner_ref, schema_family, schema_version, config_revision, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, value.resourceKey, value.role, value.attemptId ?? null, value.objectiveId ?? null, value.generation,
          json(value.ownerRef), value.schemaFamily, value.schemaVersion, value.configRevision, value.heartbeatAt);
      const claim = this.decodeClaim(this.claimRow(id));
      this.storageEvent('claim.registered', owner, { claim: object(claim) });
      return claim;
    });
  }

  claim(id: string): Claim {
    text(id);
    return this.snapshot(() => this.decodeClaim(this.claimRow(id)));
  }

  async resolveClaimByPerson(id: string, evidence: string, caller: TaskActor, command: CommandInput): Promise<Claim> {
    taskActor(caller); nonblank(evidence);
    return this.writeTask(command, () => {
      const claim = this.decodeClaim(this.claimRow(id));
      if (claim.releasedAt) return claim;
      const proof = { claimId: id, generation: claim.generation, ownerRef: claim.ownerRef, evidence, confirmStopped: true };
      if (claim.role === 'worker_owner' && claim.attemptId !== undefined) this.recordConfirmedStopInTransaction(claim.attemptId, caller);
      this.db.prepare('UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1 WHERE id = ?')
        .run(new Date().toISOString(), json(proof), id);
      this.storageEvent('claim.resolved', caller, proof);
      return this.decodeClaim(this.claimRow(id));
    });
  }

  /** A succeeded stop or fence that confirmed the direct child's exit is terminal evidence (R07). */
  private recordConfirmedStopInTransaction(attemptId: string, caller: TaskActor): void {
    const attempt = this.attemptRow(attemptId);
    if (attempt.runtime_ref === null) return;
    const terminal = this.db.prepare(`SELECT 1 FROM events WHERE attempt_id = ? AND kind = 'worker.observed'
      AND json_extract(payload, '$.kind') = 'terminal' LIMIT 1`).get(attemptId);
    if (terminal) return;
    const stop = this.db.prepare(`SELECT * FROM requests WHERE attempt_id = ? AND category = 'effect'
      AND operation IN ('worker.emergency-stop', 'worker.fence') AND state = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(attemptId);
    if (!stop) return;
    const request = this.decodeRequest(stop), result = request.result;
    if (!result || result.status !== 'confirmed' || object(result.value).terminal !== true) return;
    const workerRef = object(JSON.parse(String(attempt.runtime_ref))) as WorkerReference;
    const observation: WorkerObservation = { sourceId: `stop:${request.id}`, sourceSequence: 0, attemptId, workerRef,
      observedAt: request.claimedAt ?? request.createdAt, kind: 'terminal', payloadVersion: 1,
      payload: workerRef.launcher === 'pi' ? { directChildExited: true } : { terminal: true, laterTurnsRefused: true } };
    workerObservation(observation);
    this.insertEvent({ sourceKey: `worker.observation:${json([attemptId, observation.sourceId, 0])}`, kind: 'worker.observed',
      payloadVersion: 1, correlationId: attemptId, actor: object(caller), occurredAt: observation.observedAt,
      attemptId, taskId: String(attempt.task_id), requestId: request.id, payload: observation });
  }

  async resolveEffectByPerson(id: string, happened: boolean, evidence: string, caller: TaskActor, command: CommandInput): Promise<StoredRequest> {
    taskActor(caller); nonblank(evidence);
    return this.writeTask(command, () => {
      const request = this.decodeRequest(this.requestRow(id));
      if (request.category !== 'effect' || !['claimed', 'uncertain'].includes(request.state)) throw new StorageError('conflict', 'Effect is not unresolved');
      const proof = object({ effectId: id, target: request.target, evidence, confirmStopped: true, happened });
      this.db.prepare('UPDATE requests SET state = ?, result = ?, revision = revision + 1 WHERE id = ?')
        .run(happened ? 'succeeded' : 'rejected', json(proof), id);
      this.storageEvent('effect.resolved', caller, proof, id);
      return this.decodeRequest(this.requestRow(id));
    });
  }

  claims(): Claim[] {
    return this.snapshot(() => this.db.prepare('SELECT * FROM claims ORDER BY resource_key, id').all().map(row => this.decodeClaim(row)));
  }

  async refreshClaim(identity: ClaimIdentity, heartbeatAt: string, actor: JsonObject): Promise<Claim> {
    claimIdentity(identity); timestamp(heartbeatAt);
    const expected = { ...identity }, owner = object(actor);
    return this.write(() => this.refreshClaimInTransaction(expected, heartbeatAt, owner));
  }

  private refreshClaimInTransaction(identity: ClaimIdentity, heartbeatAt: string, actor: JsonObject): Claim {
    claimIdentity(identity); timestamp(heartbeatAt);
    const expected = { ...identity }, owner = object(actor);
    const before = this.activeClaim(expected);
    this.changed(this.db.prepare(`UPDATE claims SET heartbeat_at = ?, revision = revision + 1
      WHERE id = ? AND generation = ? AND revision = ? AND released_at IS NULL`)
      .run(heartbeatAt, expected.claimId, expected.generation, before.revision));
    const claim = this.decodeClaim(this.claimRow(expected.claimId));
    this.storageEvent('claim.refreshed', owner, { claim: object(claim) });
    return claim;
  }

  async releaseClaim(identity: ClaimIdentity, evidence: JsonObject, actor: JsonObject): Promise<Claim> {
    claimIdentity(identity);
    const expected = { ...identity }, proof = object(evidence), owner = object(actor);
    if (Object.keys(proof).length === 0) throw new TypeError('Release requires evidence');
    return this.write(() => {
      const before = this.activeClaim(expected);
      this.changed(this.db.prepare(`UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1
        WHERE id = ? AND generation = ? AND revision = ? AND released_at IS NULL`)
        .run(new Date().toISOString(), json(proof), expected.claimId, expected.generation, before.revision));
      const claim = this.decodeClaim(this.claimRow(expected.claimId));
      this.storageEvent('claim.released', owner, { claim: object(claim) });
      return claim;
    });
  }

  private requestRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) throw new StorageError('conflict', `Unknown request: ${id}`);
    return row;
  }

  private decodeRequest(row: Record<string, unknown>): StoredRequest {
    const request: StoredRequest = { id: String(row.id), requestKey: String(row.request_key), category: row.category as StoredRequest['category'],
      operation: String(row.operation), caller: object(JSON.parse(String(row.caller))), fingerprint: String(row.fingerprint),
      input: object(JSON.parse(String(row.input))), target: row.category === 'command' ? null : JSON.parse(String(row.target)) as EffectTarget,
      parentId: row.parent_id === null ? null : String(row.parent_id),
      attemptId: row.attempt_id === null ? null : String(row.attempt_id), objectiveId: row.objective_id === null ? null : String(row.objective_id),
      state: row.state as EffectState, claimId: row.claim_id === null ? null : String(row.claim_id), revision: Number(row.revision),
      createdAt: String(row.created_at), claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      result: row.result === null ? null : object(JSON.parse(String(row.result))) };
    const common: CommandInput = { requestKey: request.requestKey, operation: request.operation, caller: request.caller,
      fingerprint: request.fingerprint, input: request.input };
    commandInput(common);
    if (request.category === 'effect') {
      text(request.parentId); text(request.claimId);
      const claim = this.decodeClaim(this.claimRow(request.claimId));
      effectInput({ ...common, parentId: request.parentId, executor: { claimId: claim.id, generation: claim.generation }, target: request.target! });
      object(request.target!.reference);
    } else if (request.category !== 'command') throw new TypeError('Invalid request category');
    if (!['pending', 'claimed', 'succeeded', 'rejected', 'withdrawn', 'uncertain'].includes(request.state)) throw new TypeError('Invalid request state');
    return request;
  }

  request(id: string): StoredRequest {
    text(id);
    return this.snapshot(() => this.decodeRequest(this.requestRow(id)));
  }

  requests(): StoredRequest[] {
    return this.snapshot(() => this.db.prepare('SELECT * FROM requests ORDER BY created_at, id').all().map(row => this.decodeRequest(row)));
  }

  private duplicateRequest(value: CommandInput, category: 'command' | 'effect'): StoredRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE request_key = ?').get(value.requestKey);
    if (!row) return undefined;
    const previous = this.decodeRequest(row);
    if (previous.category !== category || previous.operation !== value.operation ||
      json(previous.caller) !== json(value.caller) || previous.fingerprint !== value.fingerprint) {
      throw new StorageError('request_input_mismatch', `Request key has different input: ${value.requestKey}`);
    }
    return previous;
  }

  async recordCommand(input: CommandInput): Promise<StoredRequest> {
    commandInput(input);
    const value: CommandInput = { ...JSON.parse(json(input)) as CommandInput, caller: object(input.caller), input: object(input.input) };
    return this.write(() => this.recordCommandInTransaction(value));
  }

  private recordCommandInTransaction(input: CommandInput, attemptId?: string): StoredRequest {
    commandInput(input);
    const value: CommandInput = { ...JSON.parse(json(input)) as CommandInput, caller: object(input.caller), input: object(input.input) };
    const previous = this.duplicateRequest(value, 'command');
    if (previous) return previous;
    this.validateScope(attemptId, undefined);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO requests (id, request_key, category, operation, caller, fingerprint, input, target, attempt_id, created_at)
      VALUES (?, ?, 'command', ?, ?, ?, ?, '{}', ?, ?)`)
      .run(id, value.requestKey, value.operation, json(value.caller), value.fingerprint, json(value.input), attemptId ?? null, new Date().toISOString());
    const request = this.decodeRequest(this.requestRow(id));
    this.storageEvent('request.recorded', value.caller, { request: object(request) }, id);
    return request;
  }

  private pendingCommand(id: string): StoredRequest {
    const request = this.decodeRequest(this.requestRow(id));
    if (request.category !== 'command' || request.state !== 'pending') throw new StorageError('conflict', 'Command is not pending');
    return request;
  }

  private bindCommandInTransaction(id: string, attemptId: string, result: JsonObject): StoredRequest {
    const before = this.pendingCommand(id);
    this.validateScope(attemptId, undefined);
    this.changed(this.db.prepare(`UPDATE requests SET attempt_id = ?, result = ?, revision = revision + 1
      WHERE id = ? AND attempt_id IS NULL AND state = 'pending' AND revision = ?`)
      .run(attemptId, json(result), id, before.revision));
    return this.decodeRequest(this.requestRow(id));
  }

  private finishPendingCommandInTransaction(id: string, state: 'succeeded' | 'rejected', result: JsonObject): StoredRequest {
    const before = this.pendingCommand(id);
    this.changed(this.db.prepare(`UPDATE requests SET state = ?, result = ?, revision = revision + 1
      WHERE id = ? AND state = 'pending' AND revision = ?`).run(state, json(result), id, before.revision));
    return this.decodeRequest(this.requestRow(id));
  }

  private claimCommandInTransaction(id: string, executor: ClaimIdentity): StoredRequest {
    const before = this.pendingCommand(id), claim = this.activeClaim(executor);
    if (heartbeatStatus(claim.heartbeatAt, Date.now()) !== 'fresh' || json(claim.ownerRef) !== json(before.caller)
      || (claim.attemptId !== undefined && claim.attemptId !== before.attemptId)
      || (claim.objectiveId !== undefined && claim.objectiveId !== before.objectiveId)) {
      throw new StorageError('conflict', 'Command executor does not match caller and scope');
    }
    this.changed(this.db.prepare(`UPDATE requests SET state = 'claimed', claim_id = ?, claimed_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'pending' AND revision = ?`).run(claim.id, new Date().toISOString(), id, before.revision));
    return this.decodeRequest(this.requestRow(id));
  }

  async recordEffect(input: EffectInput): Promise<StoredRequest> {
    effectInput(input);
    const value = JSON.parse(json(input)) as EffectInput;
    return this.write(() => this.recordEffectInTransaction(value));
  }

  private recordEffectInTransaction(input: EffectInput): StoredRequest {
    effectInput(input);
    const value = JSON.parse(json(input)) as EffectInput;
    value.caller = object(input.caller); value.input = object(input.input); value.target.reference = object(input.target.reference);
    const previous = this.duplicateRequest(value, 'effect');
    if (previous) {
      const claim = this.decodeClaim(this.claimRow(previous.claimId!));
      if (previous.parentId !== value.parentId || json(previous.input) !== json(value.input) ||
        json(previous.target) !== json(value.target) || previous.claimId !== value.executor.claimId ||
        claim.generation !== value.executor.generation || previous.attemptId !== (value.attemptId ?? null) ||
        previous.objectiveId !== (value.objectiveId ?? null)) {
        throw new StorageError('request_input_mismatch', 'Effect inputs are immutable');
      }
      return previous;
    }
    const parent = this.decodeRequest(this.requestRow(value.parentId));
    if (parent.category !== 'command' || json(parent.caller) !== json(value.caller)) throw new StorageError('conflict', 'Effect must belong to its authorising command and caller');
    const claim = this.activeClaim(value.executor);
    if (value.operation === 'worker.prepare' || value.operation === 'worker.activate') {
      if (!value.attemptId || value.requestKey !== `${value.operation}:${value.attemptId}`
        || parent.operation !== 'attempt.dispatch' || parent.attemptId !== value.attemptId || value.target.kind !== 'worker') {
        throw new StorageError('conflict', 'Worker effects must use the attempt dispatch and its unique effect key');
      }
      const attempt = this.attemptRow(value.attemptId);
      if (claim.resourceKey !== `worker:${value.attemptId}` || claim.role !== 'worker_owner'
        || attempt.phase !== 'running' || attempt.launch_state !== 'pending') {
        throw new StorageError('conflict', 'Attempt is not awaiting its worker effect');
      }
      if (value.operation === 'worker.activate' && (attempt.owner_claim_id !== claim.id || attempt.runtime_ref === null
        || json(value.target.reference) !== json(JSON.parse(String(attempt.runtime_ref)))
        || json(value.input) !== json({ specification: JSON.parse(String(attempt.specification)) }))) {
        throw new StorageError('conflict', 'Activation must match the bound worker and stored input');
      }
    }
    this.validateScope(value.attemptId, value.objectiveId);
    if ((claim.attemptId !== undefined && claim.attemptId !== value.attemptId) ||
      (claim.objectiveId !== undefined && claim.objectiveId !== value.objectiveId)) throw new StorageError('conflict', 'Effect scope differs from its executor claim');
    const id = randomUUID();
    this.db.prepare(`INSERT INTO requests (id, request_key, category, operation, parent_id, attempt_id, objective_id,
      caller, fingerprint, input, target, claim_id, created_at) VALUES (?, ?, 'effect', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, value.requestKey, value.operation, value.parentId, value.attemptId ?? null, value.objectiveId ?? null,
        json(value.caller), value.fingerprint, json(value.input), json(value.target), claim.id, new Date().toISOString());
    const request = this.decodeRequest(this.requestRow(id));
    this.storageEvent('request.recorded', value.caller, { request: object(request) }, id);
    return request;
  }

  private effect(id: string, state: EffectState): StoredRequest {
    const request = this.decodeRequest(this.requestRow(id));
    if (request.category !== 'effect' || request.state !== state) throw new StorageError('conflict', `Effect is not ${state}`);
    return request;
  }

  private effectExecutor(request: StoredRequest, identity: ClaimIdentity): Claim {
    if (request.claimId !== identity.claimId) throw new StorageError('conflict', 'Effect belongs to another executor claim');
    return this.activeClaim(identity);
  }

  async claimEffect(id: string, identity: ClaimIdentity): Promise<StoredRequest> {
    text(id); claimIdentity(identity);
    const expected = { ...identity };
    return this.write(() => this.claimEffectInTransaction(id, expected));
  }

  private claimEffectInTransaction(id: string, identity: ClaimIdentity): StoredRequest {
    text(id); claimIdentity(identity);
    const expected = { ...identity };
    const before = this.effect(id, 'pending');
    const claim = this.effectExecutor(before, expected);
    if (before.operation === 'worker.activate' || before.operation === 'worker.prepare') this.checkWorkerEffectInTransaction(before, expected);
    if (before.operation.startsWith('completion.')) this.checkCompletionEffectInTransaction(before, expected);
    if (heartbeatStatus(claim.heartbeatAt, Date.now()) !== 'fresh') throw new StorageError('conflict', 'Executor heartbeat is not fresh');
    this.changed(this.db.prepare(`UPDATE requests SET state = 'claimed', claimed_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'pending' AND revision = ? AND claim_id = ?`)
      .run(new Date().toISOString(), id, before.revision, expected.claimId));
    const request = this.decodeRequest(this.requestRow(id));
    this.storageEvent('request.claimed', claim.ownerRef, { request: object(request), generation: expected.generation }, id);
    return request;
  }

  /** Only the command's caller may close a pending effect, before an executor claims it. */
  async closePendingEffect(id: string, state: 'withdrawn' | 'rejected', result: JsonObject, caller: JsonObject): Promise<StoredRequest> {
    text(id);
    if (!['withdrawn', 'rejected'].includes(state)) throw new TypeError('Invalid pending effect transition');
    const outcome = object(result), actor = object(caller);
    if (Object.keys(outcome).length === 0) throw new TypeError('Effect closure requires evidence');
    return this.write(() => {
      const before = this.effect(id, 'pending');
      if (json(before.caller) !== json(actor)) throw new StorageError('conflict', 'Effect caller does not match');
      this.changed(this.db.prepare(`UPDATE requests SET state = ?, result = ?, revision = revision + 1
        WHERE id = ? AND state = 'pending' AND revision = ?`).run(state, json(outcome), id, before.revision));
      if (before.operation.startsWith('completion.')) {
        this.db.prepare('UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1 WHERE id = ?')
          .run(new Date().toISOString(), json(outcome), before.claimId!);
      }
      const request = this.decodeRequest(this.requestRow(id));
      this.storageEvent(`request.${state}`, actor, { request: object(request) }, id);
      return request;
    });
  }

  async recordEffectOutcome(id: string, identity: ClaimIdentity, state: EffectOutcome, result: JsonObject): Promise<StoredRequest> {
    text(id); claimIdentity(identity);
    const expected = { ...identity }, outcome = object(result);
    return this.write(() => this.recordEffectOutcomeInTransaction(id, expected, state, outcome));
  }

  private recordEffectOutcomeInTransaction(id: string, identity: ClaimIdentity, state: EffectOutcome, result: JsonObject): StoredRequest {
    text(id); claimIdentity(identity);
    if (!['succeeded', 'rejected', 'uncertain'].includes(state)) throw new TypeError('Invalid effect outcome');
    const expected = { ...identity }, outcome = object(result);
    if (Object.keys(outcome).length === 0) throw new TypeError('Effect outcome requires evidence');
    const before = this.effect(id, 'claimed');
    const claim = this.effectExecutor(before, expected);
    this.changed(this.db.prepare(`UPDATE requests SET state = ?, result = ?, revision = revision + 1
      WHERE id = ? AND state = 'claimed' AND revision = ? AND claim_id = ?`)
      .run(state, json(outcome), id, before.revision, expected.claimId));
    if (before.operation.startsWith('completion.') && state !== 'uncertain') {
      this.db.prepare('UPDATE claims SET released_at = ?, release_evidence = ?, revision = revision + 1 WHERE id = ?')
        .run(new Date().toISOString(), json(outcome), claim.id);
    }
    const request = this.decodeRequest(this.requestRow(id));
    this.storageEvent(`request.${state}`, claim.ownerRef, { request: object(request), generation: expected.generation }, id);
    return request;
  }

  /** A consistent context-wide read. Time can block admission, never grant ownership. */
  admissionBlockers(now = Date.now()): AdmissionBlocker[] {
    if (!Number.isFinite(now)) throw new TypeError('Expected a finite observation time');
    return this.snapshot(() => this.readAdmissionBlockers(now));
  }

  private readAdmissionBlockers(now: number): AdmissionBlocker[] {
      const blockers: AdmissionBlocker[] = [];
      for (const row of this.db.prepare('SELECT * FROM claims WHERE released_at IS NULL ORDER BY resource_key, id').all()) {
        const reason = heartbeatStatus(row.heartbeat_at, now);
        if (reason !== 'fresh') blockers.push({ kind: 'claim', claimId: String(row.id), resourceKey: String(row.resource_key), reason });
      }
      for (const row of this.db.prepare(`SELECT requests.id, requests.state, claims.released_at, claims.heartbeat_at
        FROM requests LEFT JOIN claims ON claims.id = requests.claim_id
        WHERE category = 'effect' AND state IN ('claimed', 'uncertain') ORDER BY requests.id`).all()) {
        if (row.state === 'uncertain' || row.released_at !== null || heartbeatStatus(row.heartbeat_at, now) !== 'fresh') {
          blockers.push({ kind: 'effect', requestId: String(row.id), reason: row.state as 'claimed' | 'uncertain' });
        }
      }
      return blockers;
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
