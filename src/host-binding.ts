import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createBinding, catalogueForRole } from './binding.ts';
import { openContext } from './context.ts';
import { strictJson } from './configuration.ts';
import { CommandFailure } from './response.ts';
import { PrivateFileError, windowsPrivateFile, windowsSecurePrivateDirectory } from './adapters/host-files.ts';

export const MAX_BINDING_BYTES = 16 * 1024;

export function hostBindingRefusal(error: unknown, fallback: string): CommandFailure {
  const failure = new CommandFailure('invalid_input');
  const conditions: Record<string, string> = { ENOENT: 'file or directory is missing', ENOTDIR: 'not a directory',
    ELOOP: 'linked path', EACCES: 'file or directory access denied', EPERM: 'file or directory access denied' };
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const reason = error instanceof PrivateFileError ? error.message : conditions[code] ?? fallback;
  failure.diagnostic = `Host binding refused: ${reason}.`.slice(0, 1024);
  return failure;
}

function checkPosixPrivacy(info: { uid: number; mode: number }): void {
  if (info.uid !== process.getuid!()) throw new PrivateFileError('owner mismatch');
  if ((info.mode & 0o077) !== 0) throw new PrivateFileError('group or other access');
}

interface HostBinding {
  version: 1;
  config: string;
  contextId: string;
  databaseId: string;
  caller: { kind: 'host'; id: string };
  operations: string[];
}

function valid(value: unknown): value is HostBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const b = value as HostBinding;
  return Object.keys(b).sort().join() === 'caller,config,contextId,databaseId,operations,version'
    && b.version === 1 && typeof b.config === 'string' && resolve(b.config) === b.config
    && typeof b.contextId === 'string' && !!b.contextId && typeof b.databaseId === 'string' && !!b.databaseId
    && !!b.caller && Object.keys(b.caller).sort().join() === 'id,kind' && b.caller.kind === 'host'
    && typeof b.caller.id === 'string' && !!b.caller.id
    && Array.isArray(b.operations) && b.operations.length > 0 && new Set(b.operations).size === b.operations.length
    && b.operations.every(name => catalogueForRole('host').some(op => op.name === name));
}

/** Inspect every component: native realpath can expand Windows short names without a link. */
export async function assertUnlinkedHostPath(
  path: string,
  inspect: (path: string) => Promise<{ isSymbolicLink(): boolean }> = lstat,
  paths = { dirname, resolve },
): Promise<void> {
  let current = paths.resolve(path);
  for (;;) {
    // lstat reports both symbolic links and Windows junctions as symbolic links.
    if ((await inspect(current)).isSymbolicLink()) throw new PrivateFileError('linked path');
    const parent = paths.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function checkBindingDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new PrivateFileError('linked path');
  if (!info.isDirectory()) throw new PrivateFileError('not a directory');
  if (process.platform === 'win32') await windowsPrivateFile(path);
  else checkPosixPrivacy(info);
}

export async function readHostBinding(path: string): Promise<HostBinding> {
  try {
    const absolute = resolve(path);
    await assertUnlinkedHostPath(absolute);
    await checkBindingDirectory(dirname(absolute));
    const before = await lstat(absolute);
    if (!before.isFile()) throw new PrivateFileError('not a regular file');
    if (before.nlink !== 1) throw new PrivateFileError('more than one hard link');
    if (before.size > MAX_BINDING_BYTES) throw new PrivateFileError('too large');
    if (process.platform === 'win32') await windowsPrivateFile(absolute);
    else checkPosixPrivacy(before);
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new PrivateFileError('not a regular file');
      if (info.dev !== before.dev || info.ino !== before.ino) throw new PrivateFileError('file changed while opening');
      if (info.nlink !== 1) throw new PrivateFileError('more than one hard link');
      if (info.size > MAX_BINDING_BYTES) throw new PrivateFileError('too large');
      if (process.platform !== 'win32') checkPosixPrivacy(info);
      const buffer = Buffer.alloc(MAX_BINDING_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BINDING_BYTES) throw new PrivateFileError('too large');
      let value: unknown;
      try { value = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))); }
      catch { throw new PrivateFileError('invalid content'); }
      if (value && typeof value === 'object' && 'version' in value && value.version !== 1) throw new PrivateFileError('wrong version');
      if (!valid(value)) throw new PrivateFileError('invalid content');
      return value;
    } finally { await file.close(); }
  } catch (error) { throw hostBindingRefusal(error, 'file metadata or binding could not be read'); }
}

export async function loadHostBinding(path: string, operation: string) {
  const binding = await readHostBinding(path);
  if (!binding.operations.includes(operation)) throw new CommandFailure('permission_denied');
  const context = await openContext({ config: binding.config }, { readOnly: true });
  try {
    if (context.databaseId !== binding.databaseId || context.configuration.resolved.contextId !== binding.contextId) {
      const failure = new CommandFailure('context_mismatch');
      failure.diagnostic = 'Host binding refused: context or database mismatch.';
      throw failure;
    }
  } finally { context.database.close(); }
  const trusted = createBinding(binding.caller, { config: binding.config });
  return {
    execute: async (args: Record<string, unknown>, requestId: string, progress: (message: string) => void) => {
      if (Object.hasOwn(args, 'caller')) throw new CommandFailure('invalid_input');
      const result = await trusted.execute(operation, args, requestId, progress);
      if (operation === 'catalog.show') result.operations = (result.operations as { name: string }[]).filter(op => binding.operations.includes(op.name));
      return result;
    },
  };
}

/** A new dedicated directory avoids changing permissions on an existing host directory. */
export async function writeHostBinding(directory: string, binding: HostBinding): Promise<string> {
  if (!valid(binding)) throw hostBindingRefusal(new PrivateFileError('wrong version or invalid content'), 'invalid content');
  if (Buffer.byteLength(JSON.stringify(binding)) > MAX_BINDING_BYTES) throw hostBindingRefusal(new PrivateFileError('too large'), 'too large');
  const root = resolve(directory), path = join(root, 'binding.json');
  try {
    await mkdir(root, { mode: 0o700 });
    await assertUnlinkedHostPath(root);
    if (process.platform === 'win32') await windowsSecurePrivateDirectory(root);
    await checkBindingDirectory(root);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(binding)}\n`); } finally { await file.close(); }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw hostBindingRefusal(error, 'directory or file could not be created');
    const existing = await readHostBinding(path);
    if (JSON.stringify(existing) !== JSON.stringify(binding)) throw hostBindingRefusal(new PrivateFileError('existing binding differs'), 'existing binding differs');
  }
  await readHostBinding(path);
  return path;
}
