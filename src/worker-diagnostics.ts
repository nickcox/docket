import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JsonObject } from './storage/database.ts';
import type { StoredRequest } from './storage/requests.ts';

export function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** Paths are owner evidence, never reconstructed from an attempt or session name. */
export function workerDiagnostics(stateDirectory: string, preparations: Pick<StoredRequest, 'result'>[]) {
  if (preparations.length !== 1) return null;
  const reference = preparations[0]!.result?.reference as JsonObject | undefined;
  if (reference?.launcher !== 'pi' || typeof reference.directory !== 'string') return null;
  if (!isAbsolute(reference.directory)) return null;
  const root = resolve(reference.directory), workers = join(stateDirectory, 'workers');
  if (relative(workers, root) === '' || !within(workers, root)) return null;
  const transcript = reference.sessionFile;
  if (transcript !== undefined && (typeof transcript !== 'string' || !isAbsolute(transcript)
    || !within(join(root, 'sessions'), transcript) || relative(join(root, 'sessions'), transcript) === '')) return null;
  return { root, transcript: typeof transcript === 'string' ? resolve(transcript) : null, reference };
}
