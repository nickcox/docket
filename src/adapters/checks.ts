import { spawn } from 'node:child_process';
import type { CheckDefinition } from '../storage/reservations.ts';
import type { JsonObject } from '../storage/database.ts';

export interface CheckCommandResult extends JsonObject {
  status: 'passed' | 'failed' | 'not_run' | 'uncertain';
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export type CheckRunner = (check: CheckDefinition, workspace: string) => Promise<CheckCommandResult>;
export function redactDiagnostics(text: string, secrets: readonly string[] = []): string {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"']+/gi, '$1[redacted]')
    .replace(/\b((?:access_token|api_key|password|secret|token)\s*[:=]\s*)[^\s&"']+/gi, '$1[redacted]');
}

/** The environment is supplied by the trusted execution profile, never inherited implicitly. */
export function checkCommandRunner(environment: NodeJS.ProcessEnv, secrets: readonly string[] = []): CheckRunner {
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith('DOCKET_')));
  return (check, workspace) => new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, timedOut = false, spawnFailed = false;
    const child = spawn(check.command[0]!, check.command.slice(1), { cwd: workspace, env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = (value: string) => {
      if (value.length > 65536) truncated = true;
      return value.slice(0, 65536);
    };
    child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout = keep(stdout + text); });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = keep(stderr + text); });
    child.once('error', () => { spawnFailed = true; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, check.timeoutMs);
    // If descendants keep the pipes open, their existence is uncertain, not a pass.
    let drain: NodeJS.Timeout | undefined, pipesOpen = false;
    child.once('exit', () => {
      clearTimeout(timer);
      drain = setTimeout(() => { pipesOpen = true; child.stdout.destroy(); child.stderr.destroy(); }, 500);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(drain);
      resolve({ status: spawnFailed ? 'not_run' : timedOut ? 'failed' : signal || pipesOpen ? 'uncertain' : code === 0 ? 'passed' : 'failed',
        exitCode: spawnFailed ? null : code, timedOut, stdout: redactDiagnostics(stdout, secrets).slice(0, 8192),
        stderr: redactDiagnostics(stderr, secrets).slice(0, 8192), truncated });
    });
  });
}
