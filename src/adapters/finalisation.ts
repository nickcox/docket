import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, strictJson } from '../configuration.ts';
import type { JsonObject } from '../storage/database.ts';
import type { GitRepository } from './repository.ts';
import { confirmed, uncertain } from './command.ts';
import type { Result } from './command.ts';

export interface FinalisationPolicy extends JsonObject {
  digest: string;
  forbidden: boolean;
  protected: boolean;
}
function restrictions(value: unknown): { forbid: string[]; protectedTargets: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid finalisation policy');
  const policy = value as Record<string, unknown>;
  if (policy.version !== 1 || Object.keys(policy).some(key => !['version', 'forbid', 'protectedTargets'].includes(key))
    || !Array.isArray(policy.forbid) || !Array.isArray(policy.protectedTargets)
    || [...policy.forbid, ...policy.protectedTargets].some(item => typeof item !== 'string' || !item.trim())) throw new Error('Invalid finalisation restrictions');
  return policy as { forbid: string[]; protectedTargets: string[] };
}

/** Only trusted trees and operator files supply restrictions; the candidate's policy is never read. */
export async function readFinalisationPolicy(repository: Pick<GitRepository, 'command'>, source: string,
  target: string, context: JsonObject, recorded: JsonObject): Promise<Result<FinalisationPolicy>> {
  try {
    const entry = await repository.command(['ls-tree', '-z', source, '--', '.docket/finalisation.json']);
    if (!entry.complete || entry.code !== 0) throw new Error('Repository policy cannot be read');
    let repositoryPolicy = restrictions({ version: 1, forbid: [], protectedTargets: [] });
    if (entry.stdout !== '') {
      if (!/^100(?:644|755) blob [a-f0-9]+\t\.docket\/finalisation\.json\0$/.test(entry.stdout)) throw new Error('Policy must be a regular file');
      const read = await repository.command(['show', `${source}:.docket/finalisation.json`]);
      if (!read.complete || read.code !== 0) throw new Error('Repository policy cannot be read');
      repositoryPolicy = restrictions(strictJson(read.stdout));
    }
    const paths = [...new Set([context.globalFile, recorded.globalFile].map(path =>
      path === null ? join(homedir(), '.config', 'docket', 'finalisation.json') : String(path)))];
    const globals = [];
    for (const path of paths) {
      try {
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('Operator policy must be a regular file');
        globals.push(restrictions(strictJson(await readFile(path, 'utf8'))));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'
          && path === join(homedir(), '.config', 'docket', 'finalisation.json'))) throw error;
      }
    }
    const policies = [repositoryPolicy, ...globals];
    const forbid = [...(context.forbid as string[]), ...(recorded.forbid as string[]), ...policies.flatMap(policy => policy.forbid)];
    const protectedTargets = policies.flatMap(policy => policy.protectedTargets);
    const shortTarget = target.replace(/^refs\/heads\//, '');
    return confirmed({ digest: createHash('sha256').update(canonicalJson({ policies, context, recorded })).digest('hex'),
      forbidden: forbid.includes('local-merge') || forbid.includes(target) || forbid.includes(shortTarget),
      protected: protectedTargets.includes(target) || protectedTargets.includes(shortTarget) });
  } catch (error) { return uncertain('Finalisation policy or target protection is unreadable', String(error)); }
}
