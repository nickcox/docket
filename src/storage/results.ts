import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StorageError } from './database.ts';
import type { JsonObject } from './database.ts';
import { commit } from './reservations.ts';
import { canonicalJson } from '../configuration.ts';
import { workerReference } from './launch.ts';
import type { WorkerReference } from './launch.ts';

export const resultValidationVersion = 1;
export const maximumResultBytes = 1024 * 1024;

export interface ResultBinding extends JsonObject {
  identity: JsonObject;
  startingCommit: string;
  outputRef: string;
  criteria: string[];
  delivery: JsonObject;
  reviewTarget?: JsonObject | null;
  resultPath: string;
  recyclableRoots: string[];
}
export interface ValidatedResult extends JsonObject {
  content: JsonObject;
  digest: string;
  relativePath: string;
  validationVersion: number;
  validatedAt: string;
  artefacts: JsonObject[];
}
export interface WorkerObservation extends JsonObject {
  sourceId: string;
  sourceSequence: number;
  attemptId: string;
  workerRef: WorkerReference;
  observedAt: string;
  kind: 'turn_ended' | 'terminal' | 'result_available' | 'idle';
  payloadVersion: 1;
  payload: JsonObject;
}

function invalid(reason: string): never { throw new StorageError('result_invalid', reason); }
function record(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('Expected result object');
  return value as JsonObject;
}
function fields(value: JsonObject, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) invalid(`Expected fields: ${names.join(', ')}`);
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid('Expected nonblank result text');
}
function list(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) invalid('Expected result array');
  return value.map(record);
}
function within(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Reject traversal and every linked component, not just the final filename. */
async function retainedFile(root: string, name: string, recyclableRoots: string[], limit?: number): Promise<{ digest: string; bytes?: Buffer }> {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)) invalid('Result path traversal is not allowed');
  const path = join(root, name);
  if (!isAbsolute(root) || resolve(root) !== root || !within(path, root)) invalid('Result must be inside retained storage');
  for (const recyclable of recyclableRoots) {
    if (within(path, recyclable)) invalid('Result is inside recyclable storage');
    try {
      if (within(path, await realpath(recyclable))) invalid('Result is inside recyclable storage');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  if (await realpath(root) !== root || await realpath(path) !== path) invalid('Result links are not allowed');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) invalid('Result must be a regular file without links');
  if (limit !== undefined && before.size > limit) invalid('Result exceeds 1 MiB');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) invalid('Result file changed during validation');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (limit !== undefined && size > limit) invalid('Result exceeds 1 MiB');
      hash.update(chunk);
      if (limit !== undefined) chunks.push(chunk);
    }
    const after = await handle.stat(), current = await lstat(path);
    if (after.size !== size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.ino !== opened.ino || current.dev !== opened.dev || current.nlink !== 1
      || await realpath(path) !== path) invalid('Result file changed during validation');
    return { digest: hash.digest('hex'), ...(limit === undefined ? {} : { bytes: Buffer.concat(chunks) }) };
  } finally { await handle.close(); }
}

export async function readWorkerResult(binding: ResultBinding): Promise<ValidatedResult> {
  try {
    const root = resolve(binding.resultPath, '..');
    const source = await retainedFile(root, relative(root, binding.resultPath), binding.recyclableRoots, maximumResultBytes);
    let content: JsonObject;
    try { content = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes))); }
    catch (error) { if (error instanceof StorageError) throw error; invalid('Malformed result JSON'); }
    fields(content, ['version', 'identity', 'startingCommit', 'outputRef', 'outcome', 'summary', 'reason', 'criteriaReport', 'evidence', 'workReferences']);
    if (content.version !== 1) invalid('Unsupported result version');
    const identity = record(content.identity);
    fields(identity, Object.keys(binding.identity));
    if (Object.entries(binding.identity).some(([key, value]) => identity[key] !== value)
      || content.startingCommit !== binding.startingCommit || content.outputRef !== binding.outputRef) {
      throw new StorageError('result_identity_mismatch', 'Result database, context, task, attempt, lease, session or refs do not match');
    }
    if (!['completed', 'held', 'failed'].includes(String(content.outcome))) invalid('Invalid result outcome');
    text(content.summary);
    if (content.outcome === 'completed') { if (content.reason !== null) invalid('Completed result reason must be null'); }
    else text(content.reason);
    const criteria = list(content.criteriaReport), positions = new Set<number>();
    if (criteria.length !== binding.criteria.length) invalid('Result must report every criterion once');
    for (const item of criteria) {
      fields(item, ['position', 'criterion', 'status', 'evidence']);
      const position = item.position;
      if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1 || position > binding.criteria.length
        || positions.has(position) || item.criterion !== binding.criteria[position - 1]) invalid('Criterion position or exact text does not match');
      positions.add(position);
      if (item.status !== 'met' && item.status !== 'not_met') invalid('Invalid criterion status');
      text(item.evidence);
    }
    const evidence = list(content.evidence), evidenceNames = new Set<string>();
    for (const item of evidence) {
      fields(item, ['name', 'summary']); text(item.name); text(item.summary);
      if (evidenceNames.has(item.name)) invalid('Duplicate evidence name');
      evidenceNames.add(item.name);
    }
    for (const name of binding.delivery.requiredEvidence as string[]) if (!evidenceNames.has(name)) invalid(`Missing required evidence: ${name}`);
    const references = list(content.workReferences), names = new Set<string>(), artefacts: JsonObject[] = [];
    let code = false, reviewed = false;
    for (const item of references) {
      text(item.name);
      if (names.has(item.name)) invalid('Duplicate work reference name');
      names.add(item.name);
      if (item.kind === 'git') {
        fields(item, ['kind', 'name', 'branch', 'commit']);
        try { commit(item.commit); } catch { invalid('Expected exact result commit'); }
        if (binding.delivery.kind === 'review') invalid('Reviewers must not commit changes');
        if (item.branch !== binding.outputRef) invalid('Git reference must match the retained output ref');
        if (code) invalid('Result must identify one code candidate');
        code = true;
        if (content.outcome === 'completed' && binding.delivery.kind === 'code' && item.commit === binding.startingCommit) invalid('Code candidate must move beyond the starting commit');
      } else if (item.kind === 'reviewed-output') {
        fields(item, ['kind', 'name', 'target']);
        if (binding.delivery.kind !== 'review' || !binding.reviewTarget || reviewed
          || canonicalJson(item.target) !== canonicalJson(binding.reviewTarget)) invalid('Reviewed output must match the immutable target exactly once');
        reviewed = true;
      } else if (item.kind === 'artefact') {
        fields(item, ['kind', 'name', 'path', 'description']); text(item.path); text(item.description);
        const file = await retainedFile(root, item.path, binding.recyclableRoots);
        artefacts.push({ name: item.name, relativePath: item.path, digest: file.digest });
      } else invalid('Invalid work reference kind');
    }
    for (const name of binding.delivery.requiredDeliverables as string[]) if (!names.has(name)) invalid(`Missing required deliverable: ${name}`);
    if (content.outcome === 'completed' && binding.delivery.kind === 'code' && !code) invalid('Completed code result requires an exact commit');
    if (content.outcome === 'completed' && binding.delivery.kind === 'review' && !reviewed) invalid('Completed review requires exactly one reviewed-output reference');
    // Artefact reads can take time. Do not record a source changed while they were checked.
    const finalSource = await retainedFile(root, relative(root, binding.resultPath), binding.recyclableRoots, maximumResultBytes);
    if (finalSource.digest !== source.digest) invalid('Result file changed during validation');
    return { content, digest: source.digest, relativePath: relative(root, binding.resultPath), validationVersion: resultValidationVersion,
      validatedAt: new Date().toISOString(), artefacts };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    invalid('Cannot read retained result');
  }
}

export function workerObservation(value: WorkerObservation): void {
  const input = record(value);
  fields(input, ['sourceId', 'sourceSequence', 'attemptId', 'workerRef', 'observedAt', 'kind', 'payloadVersion', 'payload']);
  text(value.sourceId); text(value.attemptId); text(value.observedAt);
  if (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0 || !Number.isFinite(Date.parse(value.observedAt))) invalid('Invalid observation sequence or time');
  workerReference(value.workerRef);
  if (value.payloadVersion !== 1) invalid('Unsupported observation payload version');
  const payload = record(value.payload);
  if (value.kind === 'terminal') {
    if (value.workerRef.launcher === 'pi') {
      fields(payload, ['directChildExited']);
      if (payload.directChildExited !== true) invalid('Pi terminal observation requires direct child exit');
    } else if (value.workerRef.launcher === 'bb') {
      fields(payload, ['terminal', 'laterTurnsRefused']);
      if (payload.terminal !== true || payload.laterTurnsRefused !== true) invalid('bb terminal observation requires durable refusal of later turns');
    } else invalid('Unknown terminal observation launcher');
  } else if (['turn_ended', 'result_available', 'idle'].includes(value.kind)) fields(payload, []);
  else invalid('Unsupported worker observation kind');
}
