import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { commandRunner, confirmed, isCommit, isRef, rejected, uncertain } from "./command.ts";
import type { Command, Result, Runner } from "./command.ts";

export type RefState = { state: "absent" } | { state: "present"; commit: string };
export type WorkspaceState = { branch: string | null; head: string; clean: boolean; uncommitted: string[]; untracked: string[] };
export type RepositoryOptions = { repository: string; git?: string; run?: Runner; environment?: NodeJS.ProcessEnv; timeoutMs?: number };
export type RetentionRequest = {
  references: { ref: string; commit: string }[];
  artefacts: string[];
  recyclableRoots: string[];
  workspace?: string;
};
export const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && part !== ".." && !isAbsolute(part));
};

/** Git owns refs and worktrees. This adapter makes no task, authority or retention-policy decisions. */
export class GitRepository {
  readonly options: RepositoryOptions;
  readonly run: Runner;
  constructor(options: RepositoryOptions) {
    this.options = options;
    this.run = options.run ?? commandRunner({ ...(options.environment ? { environment: options.environment } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  }
  command(args: string[], cwd = this.options.repository, input?: string): Promise<Command> {
    return this.run(this.options.git ?? "git", args, cwd, input);
  }
  async identity(workspace = this.options.repository): Promise<Result<string>> {
    const read = await this.command(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspace);
    if (!read.complete || read.code !== 0) return uncertain("Repository identity is unknown", read);
    try { return confirmed(await realpath(read.stdout.trim())); }
    catch (error) { return uncertain("Repository identity cannot be resolved", String(error)); }
  }
  async inspectRef(ref: string): Promise<Result<RefState>> {
    if (!isRef(ref)) return rejected("Invalid full ref name", ref);
    // show-ref --exists distinguishes missing (2) from failed lookup (1). rev-parse --quiet alone does not.
    const exists = await this.command(["show-ref", "--exists", ref]);
    if (!exists.complete) return uncertain("Ref lookup failed", exists);
    if (exists.code === 2) return confirmed({ state: "absent" });
    if (exists.code !== 0) return uncertain("Ref lookup failed", exists);
    const read = await this.command(["rev-parse", "--verify", `${ref}^{commit}`]);
    const commit = read.stdout.trim();
    if (!read.complete || read.code !== 0 || !isCommit(commit)) return uncertain("Ref commit could not be read", read);
    return confirmed({ state: "present", commit });
  }
  async inspectWorkspace(path: string): Promise<Result<WorkspaceState>> {
    const head = await this.command(["rev-parse", "--verify", "HEAD^{commit}"], path);
    const branch = await this.command(["symbolic-ref", "--quiet", "HEAD"], path);
    const status = await this.command(["status", "--porcelain=v1", "-z", "--untracked-files=all"], path);
    if (!head.complete || head.code !== 0 || !isCommit(head.stdout.trim()) || !branch.complete || ![0, 1].includes(branch.code!) || !status.complete || status.code !== 0) return uncertain("Workspace could not be read", { head, branch, status });
    if (branch.code === 0 && !isRef(branch.stdout.trim())) return uncertain("Malformed workspace branch", branch);
    const uncommitted: string[] = [], untracked: string[] = [];
    const entries = status.stdout.split("\0");
    if (entries.pop() !== "") return uncertain("Truncated workspace status", status);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.length < 4 || entry[2] !== " ") return uncertain("Malformed workspace status", status);
      (entry.startsWith("?? ") ? untracked : uncommitted).push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2)) && entries[++index] === undefined) return uncertain("Truncated rename status", status);
    }
    return confirmed({ head: head.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() : null, clean: entries.length === 0, uncommitted, untracked });
  }
  async compare(ancestor: string, descendant: string): Promise<Result<boolean>> {
    if (!isCommit(ancestor) || !isCommit(descendant)) return rejected("Expected exact commits");
    const read = await this.command(["merge-base", "--is-ancestor", ancestor, descendant]);
    return read.complete && [0, 1].includes(read.code!) ? confirmed(read.code === 0) : uncertain("Commit comparison failed", read);
  }
  /** All paths touched in the range, including reverted changes and merge commits. */
  async changedPaths(base: string, head: string): Promise<Result<string[]>> {
    if (!isCommit(base) || !isCommit(head)) return rejected("Expected exact commits");
    const read = await this.command(["log", "--format=", "--name-only", "-z", "--no-renames", "--diff-merges=first-parent", `${base}..${head}`, "--"]);
    if (!read.complete || read.code !== 0) return uncertain("Changed paths could not be read", read);
    return confirmed([...new Set(read.stdout.split("\0").filter(Boolean))]);
  }
  private async checkouts(ref: string): Promise<Result<string[]>> {
    const read = await this.command(["worktree", "list", "--porcelain", "-z"]);
    if (!read.complete || read.code !== 0 || !read.stdout.endsWith("\0\0")) return uncertain("Worktree inventory is unknown", read);
    const records = read.stdout.slice(0, -2).split("\0\0").map(record => record.split("\0"));
    if (records.some(record => !record[0]?.startsWith("worktree ") || !record.some(line => line.startsWith("HEAD ")))) return uncertain("Malformed worktree inventory", read);
    return confirmed(records.filter(record => record.includes(`branch ${ref}`)).map(record => record[0]!.slice(9)));
  }
  async createPinnedRef(ref: string, commit: string): Promise<Result<{ ref: string; commit: string }>> {
    return this.changeRef(ref, null, commit);
  }
  async conditionalMoveRef(ref: string, expected: string, commit: string): Promise<Result<{ ref: string; commit: string }>> {
    return this.changeRef(ref, expected, commit);
  }
  async conditionalDeleteRef(ref: string, expected: string): Promise<Result<{ ref: string; commit: null }>> {
    const result = await this.changeRef(ref, expected, null);
    return result.status === "confirmed" ? confirmed({ ref, commit: null }) : result;
  }
  private async changeRef(ref: string, expected: string | null, commit: string | null): Promise<Result<{ ref: string; commit: string }>> {
    if (!isRef(ref) || (expected !== null && !isCommit(expected)) || (commit !== null && !isCommit(commit))) return rejected("Invalid ref or commit");
    const checked = await this.checkouts(ref);
    if (checked.status !== "confirmed") return checked;
    if (checked.value.length) return rejected("Ref is checked out; use worktree-aware fast-forward", checked.value);
    const symbolic = await this.command(["symbolic-ref", "--quiet", ref]);
    if (!symbolic.complete || ![0, 1].includes(symbolic.code!)) return uncertain("Ref type is unknown", symbolic);
    if (symbolic.code === 0) return rejected("Symbolic refs cannot be moved", ref);
    const args = commit === null ? ["update-ref", "--no-deref", "-d", ref, expected!] : ["update-ref", "--no-deref", ref, commit, expected ?? ""];
    const changed = await this.command(args);
    if (!changed.complete) return uncertain("Ref mutation outcome is unknown", changed);
    if (changed.code !== 0) return rejected("Conditional ref mutation refused", changed);
    return confirmed({ ref, commit: commit! });
  }
  async conditionalFastForward(ref: string, expected: string, commit: string): Promise<Result<{ ref: string; commit: string }>> {
    if (!isRef(ref) || !isCommit(expected) || !isCommit(commit)) return rejected("Invalid ref or commit");
    const comparison = await this.compare(expected, commit);
    if (comparison.status !== "confirmed") return comparison;
    if (!comparison.value) return rejected("Not a fast-forward");
    const checked = await this.checkouts(ref);
    if (checked.status !== "confirmed") return checked;
    if (checked.value.length === 0) return this.changeRef(ref, expected, commit);
    if (checked.value.length !== 1) return rejected("Target has multiple checkouts", checked.value);
    const workspace = checked.value[0]!;
    const before = await this.inspectWorkspace(workspace);
    if (before.status !== "confirmed") return before;
    if (before.value.branch !== ref || before.value.head !== expected || !before.value.clean) return rejected("Target moved or has dirty/untracked files", before.value);
    return this.fastForwardWorktree(ref, expected, commit, workspace);
  }
  /** Hold Git's expected-old-value ref lock while updating the index/worktree, then commit the ref.
   * A lost response or a partial worktree update is uncertain, never retried or rolled back blindly. */
  private async fastForwardWorktree(ref: string, expected: string, commit: string, workspace: string): Promise<Result<{ ref: string; commit: string }>> {
    const child = spawn(this.options.git ?? "git", ["update-ref", "--stdin"], { cwd: this.options.repository, env: this.options.environment ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", touched = false, spawnError: unknown;
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.on("error", error => { spawnError = error; });
    child.stdin.on("error", () => {});
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGKILL"), this.options.timeoutMs ?? 60_000);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const step = async (input: string, response: string) => {
      child.stdin.write(input);
      const line = await lines.next();
      if (line.done || line.value !== response) throw new Error(stderr || String(spawnError ?? "Ref transaction interrupted"));
    };
    try {
      await step("start\n", "start: ok");
      // no-deref prevents a concurrent symbolic-ref from redirecting the write.
      await step(`option no-deref\nupdate ${ref} ${commit} ${expected}\nprepare\n`, "prepare: ok");
      const state = await this.inspectWorkspace(workspace);
      if (state.status !== "confirmed") return state;
      if (state.value.branch !== ref || state.value.head !== expected || !state.value.clean) return rejected("Target changed before ref lock", state.value);
      touched = true;
      const tree = await this.command(["read-tree", "-m", "-u", expected, commit], workspace);
      if (!tree.complete || tree.code !== 0) return uncertain("Worktree update did not complete; ref transaction aborted", tree);
      await step("commit\n", "commit: ok");
      child.stdin.end();
      const after = await this.inspectWorkspace(workspace);
      if (after.status !== "confirmed" || after.value.head !== commit || after.value.branch !== ref || !after.value.clean) return uncertain("Fast-forward verification failed", after);
      return confirmed({ ref, commit });
    } catch (error) {
      return touched ? uncertain("Fast-forward outcome is unknown", String(error)) : rejected("Conditional fast-forward refused before worktree update", String(error));
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      await closed;
    }
  }
  async verifyRetention(request: RetentionRequest): Promise<Result<{ retained: true }>> {
    for (const reference of request.references) {
      if (!isCommit(reference.commit)) return rejected("Invalid retained commit", reference);
      const ref = await this.inspectRef(reference.ref);
      if (ref.status !== "confirmed") return ref;
      if (ref.value.state === "absent") return rejected("Retaining ref is absent", reference);
      const contains = await this.compare(reference.commit, ref.value.commit);
      if (contains.status !== "confirmed") return contains;
      if (!contains.value) return rejected("Exact commit is not retained by ref", reference);
    }
    if (request.workspace !== undefined) {
      const state = await this.inspectWorkspace(request.workspace);
      if (state.status !== "confirmed") return state;
      if (!state.value.clean) return rejected("Workspace has unretained changes", state.value);
      const orphaned = await this.command(["rev-list", "HEAD", "--not", "--branches", "--tags"], request.workspace);
      if (!orphaned.complete || orphaned.code !== 0) return uncertain("Workspace reachability could not be read", orphaned);
      if (orphaned.stdout !== "") return rejected("Workspace has unretained commits", orphaned.stdout);
    }
    try {
      const roots = await Promise.all(request.recyclableRoots.map(root => realpath(root)));
      for (const artefact of request.artefacts) {
        if (!isAbsolute(artefact)) return rejected("Artefact path must be absolute", artefact);
        const resolved = await realpath(artefact);
        if (roots.some(root => inside(root, resolved))) return rejected("Artefact is in a recyclable root", artefact);
        if (!(await lstat(artefact)).isFile()) return rejected("Artefact must be a retained regular file", artefact);
        const file = await open(artefact, "r");
        try { if (!(await file.stat()).isFile()) return rejected("Artefact is not a regular file", artefact); await file.read(Buffer.alloc(1), 0, 1, 0); }
        finally { await file.close(); }
      }
    } catch (error) { return uncertain("Retained artefact or recyclable root could not be read", String(error)); }
    return confirmed({ retained: true });
  }
  /** Rebase an exact commit detached, never updating accepted refs, even on conflict. No automatic abort/retry. */
  async prepareRebase(workspace: string, original: string, upstream: string, onto: string): Promise<Result<{ commit: string }>> {
    if (![original, upstream, onto].every(isCommit)) return rejected("Expected exact rebase commits");
    const state = await this.inspectWorkspace(workspace);
    if (state.status !== "confirmed") return state;
    if (!state.value.clean || state.value.head !== original) return rejected("Rebase workspace moved or is dirty", state.value);
    const result = await this.command(["-c", "rebase.updateRefs=false", "-c", "rebase.autoStash=false", "-c", "rerere.enabled=false", "rebase", "--no-verify", "--no-fork-point", "--onto", onto, upstream, original], workspace);
    if (!result.complete || result.code !== 0) return uncertain("Detached rebase stopped; inspect workspace", result);
    const after = await this.inspectWorkspace(workspace);
    if (after.status !== "confirmed" || after.value.branch !== null || !after.value.clean) return uncertain("Detached rebase could not be verified", after);
    return confirmed({ commit: after.value.head });
  }
}
