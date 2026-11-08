import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRunner } from "../../src/adapters/command.ts";
import type { Result, Runner } from "../../src/adapters/command.ts";
import { GitRepository } from "../../src/adapters/repository.ts";

function value<T>(result: Result<T>): T {
  assert.equal(result.status, "confirmed", JSON.stringify(result));
  if (result.status !== "confirmed") throw new Error("Not confirmed");
  return result.value;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docket-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "repo");
  await mkdir(path);
  const run = commandRunner();
  const git = async (...args: string[]) => {
    const result = await run("git", args, path);
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Adapter tests");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(path, "file"), "base\n");
  await git("add", "."); await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  await git("switch", "-qc", "output");
  await writeFile(join(path, "file"), "output\n");
  await writeFile(join(path, "new\nfile"), "new\n");
  await git("add", "."); await git("commit", "-qm", "output");
  const head = await git("rev-parse", "HEAD");
  await git("switch", "-q", "main");
  return { root, path, git, base, head, repo: new GitRepository({ repository: path }), run };
}

test("R32/R08 ref reads distinguish absence from failed, corrupt and truncated reads", async t => {
  const f = await fixture(t);
  assert.deepEqual(value(await f.repo.inspectRef("refs/heads/missing")), { state: "absent" });
  assert.deepEqual(value(await f.repo.inspectRef("refs/heads/main")), { state: "present", commit: f.base });
  assert.equal((await new GitRepository({ repository: join(f.root, "missing") }).inspectRef("refs/heads/main")).status, "uncertain");
  await writeFile(join(f.path, ".git/refs/heads/broken"), "not-an-object\n");
  assert.equal((await f.repo.inspectRef("refs/heads/broken")).status, "uncertain");
  const run: Runner = async () => ({ code: 0, complete: false, stdout: f.base, stderr: "" });
  assert.equal((await new GitRepository({ repository: f.path, run }).inspectRef("refs/heads/main")).status, "uncertain");
});

test("R32 workspace inspection separates tracked and untracked changes; changed paths include unusual names", async t => {
  const f = await fixture(t);
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).clean, true);
  await writeFile(join(f.path, "file"), "dirty\n");
  await writeFile(join(f.path, "untracked"), "untracked\n");
  const state = value(await f.repo.inspectWorkspace(f.path));
  assert.deepEqual(state.uncommitted, ["file"]);
  assert.deepEqual(state.untracked, ["untracked"]);
  assert.deepEqual(value(await f.repo.changedPaths(f.base, f.head)).sort(), ["file", "new\nfile"].sort());
  assert.equal(value(await f.repo.compare(f.base, f.head)), true);
  assert.equal(value(await f.repo.compare(f.head, f.base)), false);
});

test("R32 create-only pins and conditional move/delete reject stale expected values and checked-out refs", async t => {
  const f = await fixture(t);
  value(await f.repo.createPinnedRef("refs/heads/pin", f.base));
  assert.equal((await f.repo.createPinnedRef("refs/heads/pin", f.head)).status, "rejected");
  assert.equal((await f.repo.conditionalMoveRef("refs/heads/pin", f.head, f.base)).status, "rejected");
  value(await f.repo.conditionalMoveRef("refs/heads/pin", f.base, f.head));
  assert.equal((await f.repo.conditionalDeleteRef("refs/heads/pin", f.base)).status, "rejected");
  assert.deepEqual(value(await f.repo.inspectRef("refs/heads/pin")), { state: "present", commit: f.head });
  value(await f.repo.conditionalDeleteRef("refs/heads/pin", f.head));
  assert.equal((await f.repo.conditionalMoveRef("refs/heads/main", f.base, f.head)).status, "rejected");
  assert.equal((await f.repo.conditionalDeleteRef("refs/heads/main", f.base)).status, "rejected");
  await f.git("symbolic-ref", "refs/heads/alias", "refs/heads/output");
  assert.equal((await f.repo.conditionalDeleteRef("refs/heads/alias", f.head)).status, "rejected");
});

test("R32 checked-out fast-forward updates worktree/index and refuses dirty or untracked targets unchanged", async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, "file"), "dirty\n");
  assert.equal((await f.repo.conditionalFastForward("refs/heads/main", f.base, f.head)).status, "rejected");
  assert.equal(await f.git("rev-parse", "main"), f.base);
  assert.equal(await readFile(join(f.path, "file"), "utf8"), "dirty\n");
  await f.git("restore", "file");
  await writeFile(join(f.path, "untracked"), "keep\n");
  assert.equal((await f.repo.conditionalFastForward("refs/heads/main", f.base, f.head)).status, "rejected");
  assert.equal(await f.git("rev-parse", "main"), f.base);
  assert.equal(await readFile(join(f.path, "untracked"), "utf8"), "keep\n");
  await rm(join(f.path, "untracked"));
  value(await f.repo.conditionalFastForward("refs/heads/main", f.base, f.head));
  assert.equal(await readFile(join(f.path, "file"), "utf8"), "output\n");
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).clean, true);
});

test("R32 checked-out fast-forward detects target movement after initial workspace read", async t => {
  const f = await fixture(t);
  const other = await f.git("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "raced");
  let raced = false;
  const run: Runner = async (exe, args, cwd, input) => {
    const read = await f.run(exe, args, cwd, input);
    if (!raced && args[0] === "status") { raced = true; await f.git("update-ref", "refs/heads/main", other, f.base); }
    return read;
  };
  const repo = new GitRepository({ repository: f.path, run });
  assert.equal((await repo.conditionalFastForward("refs/heads/main", f.base, f.head)).status, "rejected");
  assert.equal(await f.git("rev-parse", "main"), other);
  assert.equal(await readFile(join(f.path, "file"), "utf8"), "base\n");
});

test("R32 fast-forward of an un-checked-out ref uses CAS and rejects non-fast-forwards", async t => {
  const f = await fixture(t);
  value(await f.repo.createPinnedRef("refs/heads/target", f.base));
  value(await f.repo.conditionalFastForward("refs/heads/target", f.base, f.head));
  assert.equal((await f.repo.conditionalFastForward("refs/heads/target", f.base, f.head)).status, "rejected");
  assert.equal((await f.repo.conditionalFastForward("refs/heads/target", f.head, f.base)).status, "rejected");
  assert.equal(await f.git("rev-parse", "main"), f.base);
});

test("R32 conditional move/delete and unchecked fast-forward detect a ref moved between read and effect", async t => {
  const f = await fixture(t);
  for (const operation of ["move", "delete", "fast-forward"] as const) {
    await f.git("update-ref", "refs/heads/race", f.base);
    let raced = false;
    const run: Runner = async (exe, args, cwd, input) => {
      const read = await f.run(exe, args, cwd, input);
      if (!raced && args[0] === "symbolic-ref") {
        raced = true;
        await f.git("update-ref", "refs/heads/race", f.head, f.base);
      }
      return read;
    };
    const repo = new GitRepository({ repository: f.path, run });
    const result = operation === "move" ? await repo.conditionalMoveRef("refs/heads/race", f.base, f.head)
      : operation === "delete" ? await repo.conditionalDeleteRef("refs/heads/race", f.base)
      : await repo.conditionalFastForward("refs/heads/race", f.base, f.head);
    assert.equal(result.status, "rejected");
    assert.equal(await f.git("rev-parse", "refs/heads/race"), f.head);
  }
});

test("R32 linked target worktrees stay consistent and the expected ref is locked during their update", async t => {
  const f = await fixture(t);
  const linked = join(f.root, "linked target");
  await f.git("worktree", "add", "-qb", "target", linked, f.base);
  let lockObserved = false;
  const run: Runner = async (exe, args, cwd, input) => {
    if (args[0] === "read-tree") {
      const raced = await f.run("git", ["update-ref", "refs/heads/target", f.head, f.base], f.path);
      assert.notEqual(raced.code, 0);
      assert.match(raced.stderr, /lock/);
      lockObserved = true;
    }
    return f.run(exe, args, cwd, input);
  };
  value(await new GitRepository({ repository: f.path, run }).conditionalFastForward("refs/heads/target", f.base, f.head));
  assert.equal(lockObserved, true);
  assert.equal(await readFile(join(linked, "file"), "utf8"), "output\n");
  assert.equal(value(await f.repo.inspectWorkspace(linked)).clean, true);
  assert.equal(await readFile(join(f.path, "file"), "utf8"), "base\n");
});

test("R31/R32 an interrupted worktree update is uncertain and never retried", async t => {
  const f = await fixture(t);
  let effects = 0;
  const run: Runner = async (exe, args, cwd, input) => {
    if (args[0] === "read-tree") { effects++; return { complete: false, code: null, stdout: "", stderr: "lost response" }; }
    return f.run(exe, args, cwd, input);
  };
  assert.equal((await new GitRepository({ repository: f.path, run }).conditionalFastForward("refs/heads/main", f.base, f.head)).status, "uncertain");
  assert.equal(effects, 1);
  assert.equal(await f.git("rev-parse", "main"), f.base);
});

test("R32 malformed worktree inventory never permits ref-only integration", async t => {
  const f = await fixture(t);
  for (const stdout of ["", "worktree /somewhere\0HEAD nope\0", "garbage\0\0"]) {
    const run: Runner = async (exe, args, cwd, input) => args[0] === "worktree" ? { complete: true, code: 0, stdout, stderr: "" } : f.run(exe, args, cwd, input);
    assert.equal((await new GitRepository({ repository: f.path, run }).conditionalFastForward("refs/heads/main", f.base, f.head)).status, "uncertain");
  }
  assert.equal(await f.git("rev-parse", "main"), f.base);
});

test("R32 retention requires exact reachability, clean workspace and regular artefacts outside recyclable roots", async t => {
  const f = await fixture(t);
  const pool = join(f.root, "pool"); await mkdir(pool);
  const report = join(f.root, "report.json"); await writeFile(report, "{}");
  const request = { references: [{ ref: "refs/heads/output", commit: f.head }], artefacts: [report], recyclableRoots: [pool], workspace: f.path };
  value(await f.repo.verifyRetention(request));
  assert.equal((await f.repo.verifyRetention({ ...request, references: [{ ref: "refs/heads/main", commit: f.head }] })).status, "rejected");
  const recycled = join(pool, "report"); await writeFile(recycled, "{}");
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [recycled] })).status, "rejected");
  const linked = join(f.root, "linked"); await symlink(recycled, linked);
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [linked] })).status, "rejected");
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [join(f.root, "missing")] })).status, "uncertain");
  await writeFile(join(f.path, "untracked"), "work");
  assert.equal((await f.repo.verifyRetention(request)).status, "rejected");
});

test("R32 detached rebase preserves original and accepted refs on success and conflict", async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, "independent"), "target\n"); await f.git("add", "."); await f.git("commit", "-qm", "target");
  const target = await f.git("rev-parse", "HEAD");
  await f.git("switch", "-q", "output");
  const result = value(await f.repo.prepareRebase(f.path, f.head, f.base, target));
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).branch, null);
  assert.equal(await f.git("rev-parse", "output"), f.head);
  assert.equal(await f.git("rev-parse", "main"), target);
  assert.equal(value(await f.repo.compare(target, result.commit)), true);
  await f.git("switch", "-q", "main");
  await writeFile(join(f.path, "file"), "conflict\n"); await f.git("add", "."); await f.git("commit", "-qm", "conflict");
  const conflicting = await f.git("rev-parse", "HEAD");
  await f.git("switch", "-q", "output");
  assert.equal((await f.repo.prepareRebase(f.path, f.head, f.base, conflicting)).status, "uncertain");
  assert.equal(await f.git("rev-parse", "output"), f.head);
  assert.equal(await f.git("rev-parse", "main"), conflicting);
  assert.equal(await f.git("symbolic-ref", "-q", "HEAD").catch(() => "detached"), "detached");
});
