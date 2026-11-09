import { spawn } from "node:child_process";
import { createHash } from 'node:crypto';
import { createInterface } from "node:readline";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative } from "node:path";
import { commandRunner, confirmed, gitEnvironment, isCommit, isRef, rejected, uncertain } from "./command.ts";
import type { Command, Result, Runner } from "./command.ts";
import { parseCheckPolicy } from '../check-policy.ts';
import type { CheckPolicy, ContextChecks } from '../check-policy.ts';

export type RefState = { state: "absent" } | { state: "present"; commit: string };
export type WorkspaceState = { branch: string | null; head: string; clean: boolean; uncommitted: string[]; untracked: string[] };
export type RepositoryOptions = { repository: string; git?: string; run?: Runner; environment?: NodeJS.ProcessEnv; timeoutMs?: number };
export type RetentionRequest = {
  references: { ref: string; commit: string }[];
  artefacts: string[];
  artefactDigests?: { path: string; digest: string }[];
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
  readonly environment: NodeJS.ProcessEnv;
  constructor(options: RepositoryOptions) {
    this.options = options;
    this.environment = gitEnvironment(options.environment);
    this.run = options.run ?? commandRunner({ environment: this.environment, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
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
    const exists = await this.command(["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", ref]);
    if (!exists.complete || exists.code !== 0 || exists.stderr.trim() !== '') return uncertain("Ref lookup failed", exists);
    if (exists.stdout !== '' && !exists.stdout.endsWith('\n')) return uncertain("Truncated ref lookup", exists);
    const lines = exists.stdout.split('\n').filter(Boolean);
    if (lines.some(line => !/^refs\/\S+ [a-f0-9]{40}(?:[a-f0-9]{24})? (commit|tag|tree|blob)$/.test(line))) return uncertain("Malformed ref lookup", exists);
    // for-each-ref takes a prefix pattern, not an exact name.
    const exact = lines.filter(line => line.split(' ')[0] === ref);
    if (exact.length === 0) return confirmed({ state: "absent" });
    if (exact.length !== 1) return uncertain("Ambiguous ref lookup", exists);
    const [, objectId, objectType] = exact[0]!.split(' ');
    if (objectType === 'commit') return confirmed({ state: 'present', commit: objectId! });
    if (objectType !== 'tag') return uncertain('Ref does not point to a commit', exists);
    const read = await this.command(["rev-parse", "--verify", `${objectId}^{commit}`]);
    const commit = read.stdout.trim();
    if (!read.complete || read.code !== 0 || !isCommit(commit)) return uncertain("Ref commit could not be read", read);
    return confirmed({ state: "present", commit });
  }
  /** Read a fixed tree from the trusted target, never from the worker's worktree. */
  async readCheckPolicy(target: string, context: ContextChecks): Promise<CheckPolicy> {
    const ref = await this.inspectRef(target);
    if (ref.status !== 'confirmed' || ref.value.state !== 'present') throw new Error('Trusted check target cannot be read');
    const sourceCommit = ref.value.commit;
    const entry = await this.command(['ls-tree', '-z', sourceCommit, '--', '.docket/checks.json']);
    if (!entry.complete || entry.code !== 0) throw new Error('Trusted check policy cannot be read');
    if (entry.stdout === '') return parseCheckPolicy(sourceCommit, null, context);
    if (!/^100(?:644|755) blob [a-f0-9]+\t\.docket\/checks\.json\0$/.test(entry.stdout)) throw new Error('Check policy must be a regular file');
    const content = await this.command(['show', `${sourceCommit}:.docket/checks.json`]);
    if (!content.complete || content.code !== 0) throw new Error('Trusted check policy cannot be read');
    return parseCheckPolicy(sourceCommit, content.stdout, context);
  }
  async inspectWorkspace(path: string, forChecks = false, ignoredGeneratedPaths: readonly string[] = []): Promise<Result<WorkspaceState>> {
    // One owner read supplies HEAD, branch and dirt, without caching across effects.
    const status = await this.command([
      ...(forChecks ? ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] : []),
      'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all',
      ...(forChecks ? ['--ignore-submodules=none'] : []),
    ], path);
    if (forChecks) {
      const files = await this.command(['ls-files', '-v', '-z'], path);
      if (!files.complete || files.code !== 0 || (files.stdout !== '' && !files.stdout.endsWith('\0'))) return uncertain('Check index could not be read');
      if (files.stdout.split('\0').filter(Boolean).some(entry => /^[a-zS]/.test(entry))) {
        return rejected('Check workspace has assume-unchanged or skip-worktree entries');
      }
      const ignored = await this.command(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], path);
      if (!ignored.complete || ignored.code !== 0 || (ignored.stdout !== '' && !ignored.stdout.endsWith('\0'))) return uncertain('Ignored check output could not be read');
      const undeclared = ignored.stdout.split('\0').filter(Boolean).filter(file => !ignoredGeneratedPaths.some(pattern =>
        file === pattern || file.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`) || matchesGlob(file, pattern)));
      if (undeclared.length) return rejected('Workspace has ignored files not allowed by the execution profile');
    }
    if (!status.complete || status.code !== 0) return uncertain('Workspace could not be read', status);
    let head: string | undefined, branch: string | null | undefined;
    const uncommitted: string[] = [], untracked: string[] = [];
    const entries = status.stdout.split("\0");
    if (entries.pop() !== "") return uncertain("Truncated workspace status", status);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.startsWith('# branch.oid ') && head === undefined) { head = entry.slice(13); continue; }
      if (entry.startsWith('# branch.head ') && branch === undefined) {
        const name = entry.slice(14);
        branch = name === '(detached)' ? null : `refs/heads/${name}`;
        // These markers can also be literal branch names; (null) can mean a non-heads ref.
        if (name === '(null)' || name === '(detached)') {
          const symbolic = await this.command(['symbolic-ref', '--quiet', 'HEAD'], path);
          if (!symbolic.complete || ![0, 1].includes(symbolic.code!) || (symbolic.code === 0 && !isRef(symbolic.stdout.trim()))) return uncertain('Workspace branch could not be read', symbolic);
          branch = symbolic.code === 0 ? symbolic.stdout.trim() : null;
        }
        continue;
      }
      if (/^# branch\.(upstream|ab) /.test(entry)) continue;
      if (entry.startsWith('? ') && entry.length > 2) { untracked.push(entry.slice(2)); continue; }
      // v2 has fixed metadata fields, followed by an unquoted path (which may contain spaces/newlines).
      const fields = entry.startsWith('1 ') ? 8 : entry.startsWith('2 ') ? 9 : entry.startsWith('u ') ? 10 : 0;
      const match = fields ? new RegExp(`^(?:[^ ]+ ){${fields}}(.+)$`, 's').exec(entry) : null;
      if (!match) return uncertain('Malformed workspace status', status);
      uncommitted.push(match[1]!);
      if (entry.startsWith('2 ') && !entries[++index]) return uncertain('Truncated rename status', status);
    }
    if (head === undefined || !isCommit(head) || branch === undefined || (branch !== null && !isRef(branch))) return uncertain('Malformed workspace identity', status);
    return confirmed({ head, branch, clean: uncommitted.length === 0 && untracked.length === 0, uncommitted, untracked });
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
    return this.changeRef(ref, expected, null);
  }
  private async changeRef<C extends string | null>(ref: string, expected: string | null, commit: C): Promise<Result<{ ref: string; commit: C }>> {
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
    return confirmed({ ref, commit });
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
    const child = spawn(this.options.git ?? "git", ["update-ref", "--stdin"], { cwd: this.options.repository, env: this.environment, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", touched = false, spawnError: unknown;
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.on("error", error => { spawnError = error; });
    child.stdin.on("error", () => {});
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const step = async (input: string, response: string) => {
      timer = setTimeout(() => child.kill("SIGKILL"), this.options.timeoutMs ?? 60_000);
      try {
        child.stdin.write(input);
        const line = await lines.next();
        if (line.done || line.value !== response) throw new Error(stderr || String(spawnError ?? "Ref transaction interrupted"));
      } finally { clearTimeout(timer); }
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
      // The ref read already proved this exact object is a commit. Equality needs no ancestry process.
      if (reference.commit === ref.value.commit) continue;
      const contains = await this.compare(reference.commit, ref.value.commit);
      if (contains.status !== "confirmed") return contains;
      if (!contains.value) return rejected("Exact commit is not retained by ref", reference);
    }
    if (request.workspace !== undefined) {
      const repository = await this.identity();
      const workspace = await this.identity(request.workspace);
      if (repository.status !== "confirmed") return repository;
      if (workspace.status !== "confirmed") return workspace;
      if (repository.value !== workspace.value) return rejected("Retention workspace belongs to a different repository");
      const state = await this.inspectWorkspace(request.workspace);
      if (state.status !== "confirmed") return state;
      if (!state.value.clean) return rejected("Workspace has unretained changes", state.value);
      const orphaned = await this.command(["rev-list", "HEAD", "--not", "--branches", "--tags", ...request.references.map(reference => reference.ref)], request.workspace);
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
        try {
          const before = await file.stat();
          if (!before.isFile()) return rejected("Artefact is not a regular file", artefact);
          const expected = request.artefactDigests?.find(item => item.path === artefact);
          if (expected) {
            const hash = createHash('sha256');
            for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
            const after = await file.stat(), current = await lstat(artefact);
            if (hash.digest('hex') !== expected.digest || before.size !== after.size || before.mtimeMs !== after.mtimeMs
              || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) return rejected('Retained artefact changed', artefact);
          } else await file.read(Buffer.alloc(1), 0, 1, 0);
        } finally { await file.close(); }
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
    const detached = await this.command(["switch", "--detach", "--quiet", original], workspace);
    if (!detached.complete || detached.code !== 0) return uncertain("Rebase detachment could not be confirmed", detached);
    const prepared = await this.inspectWorkspace(workspace);
    if (prepared.status !== "confirmed" || prepared.value.branch !== null || prepared.value.head !== original || !prepared.value.clean) return uncertain("Rebase workspace is not clean and detached at the original commit", prepared);
    const result = await this.command(["-c", "rebase.updateRefs=false", "-c", "rebase.autoStash=false", "-c", "rerere.enabled=false", "rebase", "--no-verify", "--no-fork-point", "--onto", onto, upstream], workspace);
    if (!result.complete) return uncertain("Detached rebase stopped; inspect workspace", result);
    if (result.code !== 0) {
      const aborted = await this.command(['rebase', '--abort'], workspace);
      if (!aborted.complete || aborted.code !== 0) return uncertain('Rebase abort could not be confirmed', aborted);
      const restored = await this.command(['switch', '--quiet', state.value.branch?.replace(/^refs\/heads\//, '') ?? '--detach', ...(state.value.branch ? [] : [original])], workspace);
      const after = await this.inspectWorkspace(workspace);
      if (!restored.complete || restored.code !== 0 || after.status !== 'confirmed' || !after.value.clean
        || after.value.head !== original || after.value.branch !== state.value.branch) return uncertain('Rebase abort restoration could not be confirmed', after);
      return rejected('rebase_conflict');
    }
    const after = await this.inspectWorkspace(workspace);
    if (after.status !== "confirmed" || after.value.branch !== null || !after.value.clean) return uncertain("Detached rebase could not be verified", after);
    return confirmed({ commit: after.value.head });
  }
}
