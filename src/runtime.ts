import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { windowsSettingsWritableOnlyByOwner } from './adapters/host-files.ts';
import { PiLauncher } from './adapters/pi.ts';
import type { PiExecutionProfile } from './adapters/pi.ts';
import { GitRepository } from './adapters/repository.ts';
import { TreehouseWorkspace } from './adapters/workspace.ts';
import { completionWorkspace } from './adapters/completion-workspace.ts';
import { checkCommandRunner } from './adapters/checks.ts';
import type { ExecutionProfile } from './check-policy.ts';
import type { CompletionServices } from './completion.ts';
import type { Launcher } from './adapters/launcher.ts';
import type { Database, JsonObject } from './storage/database.ts';
import type { Configuration } from './configuration.ts';
import { ConfigurationError, strictJson } from './configuration.ts';

export interface Runtime {
  repository: GitRepository;
  workspace: TreehouseWorkspace;
  completion: CompletionServices;
  launcher: Launcher;
}
export interface ExecutionProfiles {
  version: 1;
  pi: Record<string, PiExecutionProfile>;
  checks: Record<string, ExecutionProfile>;
}
/** Host settings are person-controlled and never accepted in operation JSON. */
export async function loadExecutionProfiles(home = homedir()): Promise<ExecutionProfiles> {
  const path = join(home, '.config', 'docket', 'execution-profiles.json');
  // Only fixed condition names reach diagnostics, never an OS error or parser input.
  let condition = 'file metadata could not be read';
  try {
    const info = await lstat(path);
    condition = 'not a regular file';
    if (!info.isFile()) throw new Error();
    condition = 'link count is not one';
    if (info.nlink !== 1) throw new Error();
    condition = 'file exceeds 256 KiB';
    if (info.size > 256 * 1024) throw new Error();
    condition = process.platform === 'win32' ? 'Windows owner/write ACL is untrusted or could not be verified' : 'group or other write permission';
    if (process.platform === 'win32' ? !await windowsSettingsWritableOnlyByOwner(path) : (info.mode & 0o022) !== 0) throw new Error();
    condition = 'file contents could not be read';
    const text = await readFile(path, 'utf8');
    condition = 'invalid JSON';
    const value = strictJson(text) as ExecutionProfiles;
    condition = 'invalid execution profiles schema';
    if (!value || value.version !== 1 || Object.keys(value).some(k => !['version', 'pi', 'checks'].includes(k))
      || !value.pi || typeof value.pi !== 'object' || Array.isArray(value.pi) || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) throw new Error();
    for (const [id, profile] of Object.entries(value.checks)) {
      condition = 'invalid check profile schema';
      if (!profile || profile.id !== id || Object.keys(profile).some(k => !['id', 'tools', 'dependencies', 'ignoredGeneratedPaths'].includes(k))
        || !profile.tools || !profile.dependencies) throw new Error();
    }
    return value;
  } catch { throw new ConfigurationError('$executionProfiles', `Cannot read person-controlled execution profiles: ${condition}`); }
}
export async function createRuntime(db: Database, config: Configuration, home?: string): Promise<Runtime> {
  const profiles = await loadExecutionProfiles(home);
  const repository = new GitRepository({ repository: config.repository });
  const workspace = new TreehouseWorkspace({ repository, poolRoot: config.workspace.poolRoot,
    receiptsDirectory: join(config.stateDirectory, 'workspace-receipts') });
  const launcher = new PiLauncher({ stateDirectory: join(config.stateDirectory, 'workers'), profiles: profiles.pi,
    admit: async (_reference, input, effectId, generation) => {
      const request = db.request(effectId);
      const checked = db.checkWorkerEffect(effectId, { claimId: request.claimId!, generation });
      return JSON.stringify(checked.input.specification) === JSON.stringify(input);
    } });
  const profile = profiles.checks[String((config.checks as JsonObject).executionProfile)];
  if (!profile) throw new ConfigurationError('$executionProfiles.checks', 'Missing check execution profile');
  return { repository, workspace, launcher, completion: { repository, workspace: completionWorkspace(workspace),
    profile, run: checkCommandRunner(process.env) } };
}
