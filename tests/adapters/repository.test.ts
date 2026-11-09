import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRunner } from "../../src/adapters/command.ts";
import type { Result, Runner } from "../../src/adapters/command.ts";
import { GitRepository } from "../../src/adapters/repository.ts";
import { readFinalisationPolicy } from '../../src/adapters/finalisation.ts';

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
  await git('config', 'core.autocrlf', 'false');
  await git("config", "user.name", "Adapter tests");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(path, "file"), "base\n");
  await git("add", "."); await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  await git("switch", "-qc", "output");
  await writeFile(join(path, "file"), "output\n");
  await writeFile(join(path, "new file – café"), "new\n");
  await git("add", "."); await git("commit", "-qm", "output");
  const head = await git("rev-parse", "HEAD");
  await git("switch", "-q", "main");
  return { root, path, git, base, head, repo: new GitRepository({ repository: path }), run };
}

test("R32/R08 ref reads distinguish absence from failed, corrupt and truncated reads", async t => {
  const f = await fixture(t);
  assert.deepEqual(value(await f.repo.inspectRef("refs/heads/missing")), { state: "absent" });
  assert.deepEqual(value(await f.repo.inspectRef("refs/heads/main")), { state: "present", commit: f.base });
  await f.git('branch', 'prefix/child', f.head);
  assert.deepEqual(value(await f.repo.inspectRef('refs/heads/prefix')), { state: 'absent' });
  assert.deepEqual(value(await f.repo.inspectRef('refs/heads/prefix/child')), { state: 'present', commit: f.head });
  const commands: string[][] = [];
  const lookup: Runner = async (_program, args) => {
    commands.push(args);
    return { code: 0, complete: true, stdout: `refs/heads/prefix/child ${f.head} commit\n`, stderr: '' };
  };
  assert.deepEqual(value(await new GitRepository({ repository: f.path, run: lookup }).inspectRef('refs/heads/prefix')), { state: 'absent' });
  assert.deepEqual(commands, [['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', 'refs/heads/prefix']]);
  const failed: Runner = async () => ({ code: 1, complete: true, stdout: '', stderr: 'lookup failed' });
  assert.equal((await new GitRepository({ repository: f.path, run: failed }).inspectRef('refs/heads/prefix')).status, 'uncertain');
  assert.equal((await new GitRepository({ repository: join(f.root, "missing") }).inspectRef("refs/heads/main")).status, "uncertain");
  await writeFile(join(f.path, ".git/refs/heads/broken"), "not-an-object\n");
  assert.equal((await f.repo.inspectRef("refs/heads/broken")).status, "uncertain");
  const run: Runner = async () => ({ code: 0, complete: false, stdout: f.base, stderr: "" });
  assert.equal((await new GitRepository({ repository: f.path, run }).inspectRef("refs/heads/main")).status, "uncertain");
});

test('R10/R32: finalisation restrictions add up from the trusted tree, operator and context, never the worker', async t => {
  const f = await fixture(t), globalFile = join(f.root, 'operator.json');
  await writeFile(globalFile, JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  await mkdir(join(f.path, '.docket'));
  await writeFile(join(f.path, '.docket/finalisation.json'), JSON.stringify({ version: 1, forbid: [], protectedTargets: ['main'] }));
  await f.git('add', '.'); await f.git('commit', '-qm', 'protect main');
  const trusted = await f.git('rev-parse', 'HEAD');
  const context = { kind: 'local-merge', targetBranch: 'main', globalFile, forbid: [] };
  const protectedPolicy = value(await readFinalisationPolicy(f.repo, trusted, 'refs/heads/main', context, context));
  assert.equal(protectedPolicy.protected, true);
  await writeFile(join(f.path, '.docket/finalisation.json'), JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  assert.equal(value(await readFinalisationPolicy(f.repo, trusted, 'refs/heads/main', context, context)).protected, true);
  await writeFile(globalFile, JSON.stringify({ version: 1, forbid: ['local-merge'], protectedTargets: [] }));
  const global = value(await readFinalisationPolicy(f.repo, trusted, 'refs/heads/main', context, context));
  assert.equal(global.forbidden, true); assert.notEqual(global.digest, protectedPolicy.digest);
  await writeFile(globalFile, JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  assert.equal(value(await readFinalisationPolicy(f.repo, trusted, 'refs/heads/main', { ...context, forbid: ['local-merge'] }, context)).forbidden, true);
  assert.equal(value(await readFinalisationPolicy(f.repo, trusted, 'refs/heads/main', context, { ...context, forbid: ['main'] })).forbidden, true);
});

test('R10/R32: unreadable, executable, linked and malformed finalisation policy refuses integration', async t => {
  const f = await fixture(t), globalFile = join(f.root, 'operator.json');
  const context = { kind: 'local-merge', targetBranch: 'main', globalFile, forbid: [] };
  assert.equal((await readFinalisationPolicy(f.repo, f.base, 'refs/heads/main', context, context)).status, 'uncertain');
  for (const content of ['{', '{"version":1,"forbid":[],"protectedTargets":[],"script":"run"}', '{"version":1,"forbid":[],"forbid":["main"],"protectedTargets":[]}']) {
    await writeFile(globalFile, content);
    assert.equal((await readFinalisationPolicy(f.repo, f.base, 'refs/heads/main', context, context)).status, 'uncertain');
  }
  await rm(globalFile); await symlink(join(f.path, 'file'), globalFile);
  assert.equal((await readFinalisationPolicy(f.repo, f.base, 'refs/heads/main', context, context)).status, 'uncertain');
  await rm(globalFile); await writeFile(globalFile, JSON.stringify({ version: 1, forbid: [], protectedTargets: [] }));
  await mkdir(join(f.path, '.docket'));
  await symlink('../file', join(f.path, '.docket/finalisation.json'));
  await f.git('add', '.'); await f.git('commit', '-qm', 'linked policy');
  assert.equal((await readFinalisationPolicy(f.repo, await f.git('rev-parse', 'HEAD'), 'refs/heads/main', context, context)).status, 'uncertain');
});

test("R32 workspace inspection separates tracked and untracked changes; changed paths include unusual names", async t => {
  const f = await fixture(t);
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).clean, true);
  await writeFile(join(f.path, "file"), "dirty\n");
  await writeFile(join(f.path, "untracked"), "untracked\n");
  const state = value(await f.repo.inspectWorkspace(f.path));
  assert.deepEqual(state.uncommitted, ["file"]);
  assert.deepEqual(state.untracked, ["untracked"]);
  assert.deepEqual(value(await f.repo.changedPaths(f.base, f.head)).sort(), ["file", "new file – café"].sort());
  assert.equal(value(await f.repo.compare(f.base, f.head)), true);
  assert.equal(value(await f.repo.compare(f.head, f.base)), false);
});

test('R32/R09: combined owner reads reduce processes without reusing mutable state across calls', async t => {
  const f = await fixture(t), commands: string[][] = [];
  const repo = new GitRepository({ repository: f.path, run: async (program, args, cwd, input) => {
    commands.push(args);
    return f.run(program, args, cwd, input);
  } });
  assert.equal(value(await repo.inspectRef('refs/heads/main')).state, 'present');
  assert.equal(commands.length, 1, 'commit ref and object type come from one read');
  commands.length = 0;
  assert.equal(value(await repo.inspectWorkspace(f.path)).clean, true);
  assert.equal(commands.length, 1, 'HEAD, branch and dirt come from one read');
  await writeFile(join(f.path, 'file'), 'changed after the first read');
  assert.equal(value(await repo.inspectWorkspace(f.path)).clean, false, 'the next guard reads current dirt');
  assert.equal(commands.length, 2);
  await f.git('update-ref', 'refs/heads/main', f.head, f.base);
  assert.deepEqual(value(await repo.inspectRef('refs/heads/main')), { state: 'present', commit: f.head });
  commands.length = 0;
  value(await repo.verifyRetention({ references: [{ ref: 'refs/heads/main', commit: f.head }], artefacts: [], recyclableRoots: [] }));
  assert.equal(commands.length, 1, 'an exact retained commit needs no ancestry read');
  await f.git('tag', '-am', 'annotated', 'annotated', f.head);
  await f.git('tag', '-am', 'nested', 'nested', 'annotated');
  assert.deepEqual(value(await repo.inspectRef('refs/tags/nested')), { state: 'present', commit: f.head });
  await f.git('update-ref', 'refs/tags/blob', await f.git('rev-parse', `${f.head}:file`));
  assert.equal((await repo.inspectRef('refs/tags/blob')).status, 'uncertain');
});

test('R32: workspace branch identity preserves literal status markers and symbolic HEAD outside heads', async t => {
  const f = await fixture(t);
  for (const ref of ['refs/heads/(detached)', 'refs/heads/(null)', 'refs/custom/output']) {
    await f.git('update-ref', ref, f.base);
    await f.git('symbolic-ref', 'HEAD', ref);
    assert.equal(value(await f.repo.inspectWorkspace(f.path)).branch, ref);
  }
  await f.git('switch', '--detach', f.base);
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).branch, null);
});

test('R32: porcelain v2 preserves unusual paths, renames, conflicts and detached HEAD; incomplete reads refuse', async () => {
  const head = 'a'.repeat(40);
  const headers = `# branch.oid ${head}\0# branch.head main\0`;
  const tracked = `1 .M N... 100644 100644 100644 ${head} ${head} line\nfile\0`;
  const rename = `2 R. N... 100644 100644 100644 ${head} ${head} R100 new name\0old\nname\0`;
  const conflict = `u UU N... 100644 100644 100644 100644 ${head} ${head} ${head} conflict\0`;
  let output = headers + tracked + rename + conflict + '? untracked\nfile\0';
  let complete = true;
  const repo = new GitRepository({ repository: '.', run: async (_program, args) => args[0] === 'symbolic-ref'
    ? { code: 1, complete: true, stdout: '', stderr: '' }
    : { code: 0, complete, stdout: output, stderr: '' } });
  assert.deepEqual(value(await repo.inspectWorkspace('.')), {
    head, branch: 'refs/heads/main', clean: false,
    uncommitted: ['line\nfile', 'new name', 'conflict'], untracked: ['untracked\nfile'],
  });
  output = `# branch.oid ${head}\0# branch.head (detached)\0`;
  assert.equal(value(await repo.inspectWorkspace('.')).branch, null);
  for (const malformed of [headers.slice(0, -1), headers + rename.slice(0, rename.indexOf('old')), '# branch.head main\0',
    headers + '# branch.head other\0', headers.replace(head, '(initial)'), headers + 'unknown\0']) {
    output = malformed;
    assert.equal((await repo.inspectWorkspace('.')).status, 'uncertain', JSON.stringify(output));
  }
  output = headers; complete = false;
  assert.equal((await repo.inspectWorkspace('.')).status, 'uncertain');
});

test('R32: changed-path parsing preserves newline-containing names without requiring an OS to create them', async () => {
  const repo = new GitRepository({ repository: process.cwd(), run: async () => ({
    code: 0, complete: true, stdout: 'file\0new\nfile\0', stderr: '',
  }) });
  assert.deepEqual(value(await repo.changedPaths('a'.repeat(40), 'b'.repeat(40))), ['file', 'new\nfile']);
});

test("R32 changed paths retain reverted changes rather than just the final tree difference", async t => {
  const f = await fixture(t);
  await f.git("switch", "-q", "output");
  await f.git("revert", "--no-edit", f.head);
  const reverted = await f.git("rev-parse", "HEAD");
  assert.deepEqual(value(await f.repo.changedPaths(f.base, reverted)).sort(), ["file", "new file – café"].sort());
  assert.equal(await f.git("diff", "--name-only", f.base, reverted), "");
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
  const digestRequest = { references: [], artefacts: [report], recyclableRoots: [pool],
    artefactDigests: [{ path: report, digest: createHash('sha256').update('{}').digest('hex') }] };
  assert.equal((await f.repo.verifyRetention(digestRequest)).status, 'confirmed');
  await writeFile(report, '{"changed":true}');
  assert.equal((await f.repo.verifyRetention(digestRequest)).status, 'rejected');
  await writeFile(report, '{}');
  const request = { references: [{ ref: "refs/heads/output", commit: f.head }], artefacts: [report], recyclableRoots: [pool], workspace: f.path };
  value(await f.repo.verifyRetention(request));
  assert.equal((await f.repo.verifyRetention({ ...request, references: [{ ref: "refs/heads/main", commit: f.head }] })).status, "rejected");
  const recycled = join(pool, "report"); await writeFile(recycled, "{}");
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [recycled] })).status, "rejected");
  const linked = join(f.root, "linked"); await symlink(recycled, linked, 'file');
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [linked] })).status, "rejected");
  assert.equal((await f.repo.verifyRetention({ ...request, artefacts: [join(f.root, "missing")] })).status, "uncertain");
  await writeFile(join(f.path, "untracked"), "work");
  assert.equal((await f.repo.verifyRetention(request)).status, "rejected");
});

test("R32 retention recognises explicitly pinned non-branch refs and refuses orphaned workspace commits", async t => {
  const f = await fixture(t);
  await f.git("switch", "--detach", "-q", f.head);
  value(await f.repo.conditionalDeleteRef("refs/heads/output", f.head));
  const request = { references: [] as { ref: string; commit: string }[], artefacts: [], recyclableRoots: [], workspace: f.path };
  assert.equal((await f.repo.verifyRetention(request)).status, "rejected");
  value(await f.repo.createPinnedRef("refs/docket/retained", f.head));
  value(await f.repo.verifyRetention({ ...request, references: [{ ref: "refs/docket/retained", commit: f.head }] }));
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
  const conflict = await f.repo.prepareRebase(f.path, f.head, f.base, conflicting);
  assert.equal(conflict.status, 'rejected');
  if (conflict.status === 'rejected') assert.equal(conflict.reason, 'rebase_conflict');
  assert.equal(await f.git("rev-parse", "output"), f.head);
  assert.equal(await f.git("rev-parse", "main"), conflicting);
  assert.equal(await f.git('symbolic-ref', '-q', 'HEAD'), 'refs/heads/output');
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).clean, true);
  assert.equal(value(await f.repo.inspectWorkspace(f.path)).head, f.head);
});
