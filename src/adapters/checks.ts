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
  const redactions = [...secrets];
  return (check, workspace) => new Promise(resolve => {
    let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, timedOut = false, spawnFailed = false;
    const child = spawn(check.command[0]!, check.command.slice(1), { cwd: workspace, env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      if (stdout.length + text.length > 65536) stdoutTruncated = true;
      stdout = (stdout + text).slice(0, 65536);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      if (stderr.length + text.length > 65536) stderrTruncated = true;
      stderr = (stderr + text).slice(0, 65536);
    });
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
      // Suppress an overflowing stream rather than retaining a credential cut at the buffer boundary.
      const out = stdoutTruncated ? '[output exceeded diagnostic limit]' : redactDiagnostics(stdout, redactions);
      const err = stderrTruncated ? '[output exceeded diagnostic limit]' : redactDiagnostics(stderr, redactions);
      const crash = signal !== null && ['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT'].includes(signal);
      // Windows reports NT status values as exit codes, including console interruption.
      const interrupted = process.platform === 'win32' ? code !== null && (code >>> 0) === 0xC000013A : signal !== null && !crash;
      resolve({ status: spawnFailed ? 'not_run' : pipesOpen ? 'uncertain' : timedOut ? 'failed' : interrupted ? 'uncertain'
        : crash || (code !== null && code !== 0) ? 'failed' : signal || code === null ? 'uncertain' : 'passed',
        exitCode: spawnFailed ? null : code, signal, timedOut,
        stdout: out.slice(0, 8192), stderr: err.slice(0, 8192),
        truncated: stdoutTruncated || stderrTruncated || out.length > 8192 || err.length > 8192,
        ...(spawnFailed ? { reason: 'Command could not be started' } : {}) });
    });
  });
}
