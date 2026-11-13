import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBinding, catalogueForRole } from './binding.ts';
import { openContext } from './context.ts';
import { strictJson } from './configuration.ts';
import { CommandFailure } from './response.ts';
import { windowsPrivateFile, windowsSecurePrivateDirectory } from './adapters/host-files.ts';

export const MAX_BINDING_BYTES = 16 * 1024;
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

export async function readHostBinding(path: string): Promise<HostBinding> {
  try {
    const absolute = resolve(path);
    if (await realpath(absolute) !== absolute) throw new Error('Linked path');
    const before = await lstat(absolute);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BINDING_BYTES) throw new Error('Invalid file');
    if (process.platform === 'win32') {
      if (!await windowsPrivateFile(absolute)) throw new Error('Not private');
    } else if (before.uid !== process.getuid!() || (before.mode & 0o077) !== 0) throw new Error('Not private');
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || info.size > MAX_BINDING_BYTES) throw new Error('Changed file');
      if (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) throw new Error('Not private');
      const buffer = Buffer.alloc(MAX_BINDING_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BINDING_BYTES) throw new Error('Too large');
      const value = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      if (!valid(value)) throw new Error('Invalid binding');
      return value;
    } finally { await file.close(); }
  } catch { throw new CommandFailure('invalid_input'); }
}

export async function loadHostBinding(path: string, operation: string) {
  const binding = await readHostBinding(path);
  if (!binding.operations.includes(operation)) throw new CommandFailure('person_required');
  const context = await openContext({ config: binding.config }, { readOnly: true });
  try {
    if (context.databaseId !== binding.databaseId || context.configuration.resolved.contextId !== binding.contextId) throw new CommandFailure('context_mismatch');
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
  if (!valid(binding) || Buffer.byteLength(JSON.stringify(binding)) > MAX_BINDING_BYTES) throw new CommandFailure('invalid_input');
  const root = resolve(directory), path = join(root, 'binding.json');
  try {
    await mkdir(root, { mode: 0o700 });
    if (await realpath(root) !== root) throw new Error('Linked directory');
    if (process.platform === 'win32') await windowsSecurePrivateDirectory(root);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(binding)}\n`); } finally { await file.close(); }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new CommandFailure('invalid_input');
    const existing = await readHostBinding(path);
    if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new CommandFailure('invalid_input');
  }
  await readHostBinding(path);
  return path;
}
