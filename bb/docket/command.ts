import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    if (error) reject(new Error('Docket command failed'));
    else resolve(stdout);
  });
});

/** No shell, retries, binding reads or database access in this transport. */
export async function invoke(executable: string, binding: string, operation: string, input: Record<string, unknown>, execute: Run = run): Promise<Record<string, unknown>> {
  if (!executable.trim() || !binding.trim()) throw new Error('Configure the Docket command and host binding');
  const requestId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'docket-bb-invoke-'));
  let raw: string;
  try {
    const path = join(directory, 'input.json');
    await writeFile(path, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
    raw = await execute(executable, ['host', 'invoke', operation, '--binding', binding,
      '--input', path, '--request-id', requestId, '--json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const reply = JSON.parse(raw);
  if (reply?.version !== 1 || reply.operation !== operation || reply.requestId !== requestId
    || reply.outcome !== 'succeeded' || !reply.data || typeof reply.data !== 'object' || Array.isArray(reply.data)) {
    throw new Error('Docket returned no verified result');
  }
  return reply.data;
}
