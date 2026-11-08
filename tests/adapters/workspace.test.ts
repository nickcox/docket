import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRunner } from "../../src/adapters/command.ts";
import type { Result, Runner } from "../../src/adapters/command.ts";
import { GitRepository } from "../../src/adapters/repository.ts";
import { startingBranch, TreehouseWorkspace } from "../../src/adapters/workspace.ts";

function value<T>(result: Result<T>): T {
  assert.equal(result.status, "confirmed", JSON.stringify(result));
  if (result.status !== "confirmed") throw new Error("Not confirmed");
  return result.value;
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docket-treehouse-")));
  const repository = join(root, "repo"), poolRoot = join(root, "pool"), receiptsDirectory = join(root, "receipts");
  await mkdir(repository); await mkdir(poolRoot);
  const run = commandRunner();
  const git = async (...args: string[]) => {
    const result = await run("git", args, repository);
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.stdout.trim();
  };
  await git("init", "-q", "-b", "main"); await git("config", "user.name", "Adapter tests"); await git("config", "user.email", "test@example.invalid");
  await writeFile(join(repository, "file"), "base\n"); await git("add", "."); await git("commit", "-qm", "base");
  const startingCommit = await git("rev-parse", "HEAD");
  const repo = new GitRepository({ repository });
  const options = { repository: repo, poolRoot, receiptsDirectory };
  const workspace = new TreehouseWorkspace(options);
  const request = { databaseId: "database", attemptId: "attempt", holder: "task", branch: "output/task", startingCommit };
  t.after(async () => {
    // Only the isolated test pool is touched. Return every real lease, including deliberately lost responses.
    const status = await run("treehouse", ["--root", poolRoot, "status", "--json"], repository);
    if (status.code === 0) {
      for (const row of JSON.parse(status.stdout)) {
        if (row.lease_id) {
          const returned = await run("treehouse", ["--root", poolRoot, "return", "--force", "--if-lease-holder", row.lease_holder, "--if-lease-id", row.lease_id, row.path], repository);
          assert.equal(returned.code, 0, JSON.stringify(returned));
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, repository, poolRoot, receiptsDirectory, repo, workspace, options, request, git, run };
}

test("R32/A11 real Treehouse acquire verifies complete allocation and removes private starting ref", async t => {
  const f = await fixture(t);
  const allocation = value(await f.workspace.acquire(f.request));
  assert.ok(allocation.leaseId); assert.equal(allocation.holder, f.request.holder);
  assert.equal(allocation.branch, f.request.branch); assert.equal(allocation.startingCommit, f.request.startingCommit);
  assert.equal(allocation.repository, value(await f.repo.identity()));
  assert.ok(allocation.pool.includes(f.poolRoot));
  assert.equal(value(await f.repo.inspectWorkspace(allocation.path)).head, f.request.startingCommit);
  assert.deepEqual(value(await f.repo.inspectRef(`refs/heads/${startingBranch(f.request.databaseId, f.request.attemptId)}`)), { state: "absent" });
  assert.deepEqual(value(await f.workspace.recyclableRoots()), [f.poolRoot]);
  assert.deepEqual(value(await f.workspace.list()), [allocation]);
  assert.equal(value(await f.workspace.inspect(allocation)).state, "matching");
  for (const changed of [
    { holder: "wrong" }, { leaseId: "wrong" }, { path: f.repository }, { branch: "main" },
    { repository: f.repository }, { startingCommit: "a".repeat(40) },
  ]) {
    const read = await f.workspace.inspect({ ...allocation, ...changed });
    assert.notEqual(read.status === "confirmed" ? read.value.state : read.status, "matching", JSON.stringify(changed));
  }
  assert.equal((await f.workspace.inspect({ ...allocation, pool: "different-pool" })).status, "uncertain");
  assert.equal((await f.workspace.inspect({ path: allocation.path } as typeof allocation)).status, "rejected");

  // A new adapter process can verify the immutable start even after the worker adds commits.
  await writeFile(join(allocation.path, "work"), "finished\n");
  assert.equal((await f.run("git", ["add", "."], allocation.path)).code, 0);
  assert.equal((await f.run("git", ["commit", "-qm", "work"], allocation.path)).code, 0);
  const restarted = new TreehouseWorkspace(f.options);
  assert.equal(value(await restarted.inspect(allocation)).state, "matching");
  const head = value(await f.repo.inspectWorkspace(allocation.path)).head;
  const report = join(f.root, "report"); await writeFile(report, "evidence");
  const retention = { references: [{ ref: `refs/heads/${allocation.branch}`, commit: head }], artefacts: [report], recyclableRoots: [f.poolRoot] };
  assert.equal((await restarted.returnLease({ ...allocation, holder: "wrong" }, { authorised: true, requestId: "return-1", retention })).status, "rejected");
  assert.equal((await restarted.returnLease(allocation, { authorised: false as true, requestId: "return-1", retention })).status, "rejected");
  await writeFile(join(allocation.path, "untracked"), "keep this work");
  assert.equal((await restarted.returnLease(allocation, { authorised: true, requestId: "return-1", retention })).status, "rejected");
  assert.equal(value(await restarted.inspect(allocation)).state, "matching");
  await rm(join(allocation.path, "untracked"));
  await rm(report);
  assert.equal((await restarted.returnLease(allocation, { authorised: true, requestId: "return-1", retention })).status, "uncertain");
  assert.equal(value(await restarted.inspect(allocation)).state, "matching");
  await writeFile(report, "evidence");
  assert.deepEqual(value(await restarted.returnLease(allocation, { authorised: true, requestId: "return-1", retention })), { returned: true });
  assert.deepEqual(value(await restarted.inspect(allocation)), { state: "absent" });
  assert.deepEqual(value(await restarted.list()), []);
});

test("R32 acquisition uses the requested exact commit rather than the backing branch's newer HEAD", async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "file"), "new main\n"); await f.git("add", "."); await f.git("commit", "-qm", "new main");
  assert.notEqual(await f.git("rev-parse", "HEAD"), f.request.startingCommit);
  const allocation = value(await f.workspace.acquire(f.request));
  assert.equal(allocation.startingCommit, f.request.startingCommit);
  assert.equal(value(await f.repo.inspectWorkspace(allocation.path)).head, f.request.startingCommit);
});

test("R31/R32 lost Treehouse return acknowledgement stays uncertain and makes one return attempt", async t => {
  const f = await fixture(t);
  const allocation = value(await f.workspace.acquire(f.request));
  let returns = 0;
  const run: Runner = async (...args) => {
    const result = await f.run(...args);
    if (args[1].includes("return")) { returns++; return { ...result, complete: false, code: null }; }
    return result;
  };
  const workspace = new TreehouseWorkspace({ ...f.options, run });
  const retention = { references: [{ ref: `refs/heads/${allocation.branch}`, commit: allocation.startingCommit }], artefacts: [], recyclableRoots: [f.poolRoot] };
  assert.equal((await workspace.returnLease(allocation, { authorised: true, requestId: "return", retention })).status, "uncertain");
  assert.equal(returns, 1);
  assert.deepEqual(value(await workspace.inspect(allocation)), { state: "absent" });
});

test("R32/A11 a changed origin selects another pool and never proves a listed lease absent", async t => {
  const f = await fixture(t);
  const allocation = value(await f.workspace.acquire(f.request));
  await f.git("remote", "add", "origin", "https://example.invalid/different.git");
  assert.equal((await f.workspace.inspect(allocation)).status, "uncertain");
  await f.git("remote", "remove", "origin");
  assert.equal(value(await f.workspace.inspect(allocation)).state, "matching");
});

test("R32 starting ref is database/attempt-derived and create-only; no automatic acquisition retry", async t => {
  const f = await fixture(t);
  const branch = startingBranch(f.request.databaseId, f.request.attemptId);
  assert.notEqual(branch, startingBranch("different-database", f.request.attemptId));
  assert.notEqual(branch, startingBranch(f.request.databaseId, "different-attempt"));
  value(await f.repo.createPinnedRef(`refs/heads/${branch}`, f.request.startingCommit));
  let gets = 0;
  const run: Runner = async (...args) => { if (args[1].includes("get")) gets++; return f.run(...args); };
  const workspace = new TreehouseWorkspace({ ...f.options, run });
  assert.equal((await workspace.acquire(f.request)).status, "rejected");
  assert.equal(gets, 0);
  assert.deepEqual(value(await f.repo.inspectRef(`refs/heads/${branch}`)), { state: "present", commit: f.request.startingCommit });
});

test("R32 moved private starting ref is preserved after an otherwise verified real acquisition", async t => {
  const f = await fixture(t);
  const moved = await f.git("commit-tree", `${f.request.startingCommit}^{tree}`, "-p", f.request.startingCommit, "-m", "moved");
  let gets = 0;
  const run: Runner = async (...args) => {
    const result = await f.run(...args);
    if (args[1].includes("get")) {
      gets++;
      await f.git("update-ref", `refs/heads/${startingBranch(f.request.databaseId, f.request.attemptId)}`, moved, f.request.startingCommit);
    }
    return result;
  };
  const workspace = new TreehouseWorkspace({ ...f.options, run });
  assert.equal((await workspace.acquire(f.request)).status, "uncertain");
  assert.equal(gets, 1);
  assert.deepEqual(value(await f.repo.inspectRef(`refs/heads/${startingBranch(f.request.databaseId, f.request.attemptId)}`)), { state: "present", commit: moved });
  assert.equal(value(await workspace.list()).length, 1);
});

test("R32/A11 malformed, truncated, wrong-holder and wrong-path acquisition output never confirms a lease", async t => {
  for (const kind of ["malformed", "truncated", "wrong-holder", "wrong-path", "wrong-head"] as const) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      let gets = 0;
      const run: Runner = async (...args) => {
        const read = await f.run(...args);
        if (!args[1].includes("get")) return read;
        gets++;
        const row = JSON.parse(read.stdout);
        if (kind === "malformed") return { ...read, stdout: "{\"path\":" };
        if (kind === "truncated") return { ...read, complete: false };
        if (kind === "wrong-holder") row.lease_holder = "wrong";
        if (kind === "wrong-path") row.path = f.repository;
        if (kind === "wrong-head") {
          const head = await f.git("commit-tree", `${f.request.startingCommit}^{tree}`, "-p", f.request.startingCommit, "-m", "wrong head");
          await f.git("update-ref", `refs/heads/${f.request.branch}`, head);
        }
        return { ...read, stdout: JSON.stringify(row) };
      };
      assert.equal((await new TreehouseWorkspace({ ...f.options, run }).acquire(f.request)).status, "uncertain");
      assert.equal(gets, 1);
    });
  }
});

test("R32/A11 malformed or truncated Treehouse status is unknown, never an empty successful lookup", async t => {
  const f = await fixture(t);
  const allocation = value(await f.workspace.acquire(f.request));
  for (const stdout of ["[", "{}", '[{"path":"/somewhere"}]', '[{"path":"/somewhere","branch":"output","lease_id":"lease","lease_holder":null}]']) {
    const run: Runner = async (...args) => args[1].includes("status") ? { code: 0, complete: true, stdout, stderr: "" } : f.run(...args);
    const workspace = new TreehouseWorkspace({ ...f.options, run });
    assert.equal((await workspace.inspect(allocation)).status, "uncertain");
    assert.equal((await workspace.list()).status, "uncertain");
  }
  const run: Runner = async (...args) => args[1].includes("status") ? { code: 0, complete: false, stdout: "[]", stderr: "" } : f.run(...args);
  assert.equal((await new TreehouseWorkspace({ ...f.options, run }).inspect(allocation)).status, "uncertain");
});

test("R32/A11 wrong live branch, repository, path or holder never matches a recorded allocation", async t => {
  const f = await fixture(t);
  const allocation = value(await f.workspace.acquire(f.request));
  for (const changed of [{ lease_holder: "wrong" }, { path: f.repository }, { branch: "main" }]) {
    const run: Runner = async (...args) => {
      const read = await f.run(...args);
      if (!args[1].includes("status")) return read;
      const rows = JSON.parse(read.stdout).map((row: object) => ({ ...row, ...changed }));
      return { ...read, stdout: JSON.stringify(rows) };
    };
    assert.equal(value(await new TreehouseWorkspace({ ...f.options, run }).inspect(allocation)).state, "mismatch");
  }
  const other = join(f.root, "other-repository"); await mkdir(other);
  assert.equal((await f.run("git", ["init", "-qb", allocation.branch], other)).code, 0);
  assert.equal((await f.run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "other"], other)).code, 0);
  const markerPath = join(allocation.path, ".git"), marker = await readFile(markerPath, "utf8");
  try {
    await writeFile(markerPath, `gitdir: ${join(other, ".git")}\n`);
    const wrongRepository = await f.workspace.inspect(allocation);
    assert.notEqual(wrongRepository.status === "confirmed" ? wrongRepository.value.state : wrongRepository.status, "matching");
  } finally { await writeFile(markerPath, marker); }
  // The pool owner can still list a lease while Git no longer has its recorded branch checked out.
  assert.equal((await f.run("git", ["switch", "--detach", "-q"], allocation.path)).code, 0);
  const detached = await f.workspace.inspect(allocation);
  assert.notEqual(detached.status === "confirmed" ? detached.value.state : detached.status, "matching");
});
