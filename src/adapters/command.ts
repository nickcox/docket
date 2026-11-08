import { execFile } from "node:child_process";

export type Result<T> =
  | { status: "confirmed"; value: T }
  | { status: "rejected"; reason: string; evidence: unknown }
  | { status: "uncertain"; reason: string; referenceHints: unknown };
export const confirmed = <T>(value: T): Result<T> => ({ status: "confirmed", value });
export const rejected = (reason: string, evidence: unknown = null): Result<never> => ({ status: "rejected", reason, evidence });
export const uncertain = (reason: string, referenceHints: unknown = null): Result<never> => ({ status: "uncertain", reason, referenceHints });

export type Command = { code: number | null; stdout: string; stderr: string; complete: boolean };
export type Runner = (executable: string, args: string[], cwd: string, input?: string) => Promise<Command>;

/** One bounded invocation, no shell and no retries. A killed/truncated/failed spawn is never a complete read. */
export function commandRunner(options: { timeoutMs?: number; maxBuffer?: number; environment?: NodeJS.ProcessEnv } = {}): Runner {
  return (executable, args, cwd, input) => new Promise(resolve => {
    const child = execFile(executable, args, {
      cwd, env: options.environment ?? process.env, timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr, complete: code !== null && !error?.killed });
    });
    child.stdin?.end(input);
  });
}

export const isCommit = (value: string): boolean => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const isRef = (value: string): boolean => value.startsWith("refs/") && !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value)
  && !value.includes("..") && !value.includes("@{") && !value.includes("//") && !value.endsWith("/")
  && value.split("/").every(part => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
