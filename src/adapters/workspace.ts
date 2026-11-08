import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { commandRunner, confirmed, isCommit, isRef, rejected, uncertain } from "./command.ts";
import type { Command, Result, Runner } from "./command.ts";
import { GitRepository, inside } from "./repository.ts";
import type { RetentionRequest } from "./repository.ts";

export type Allocation = {
  leaseId: string; holder: string; path: string; pool: string; repository: string;
  branch: string; startingCommit: string;
};
export type LeaseObservation = { leaseId: string; holder: string; path: string; branch: string };
export type LeaseInspection = { state: "matching"; allocation: Allocation } | { state: "absent" } | { state: "mismatch"; reason: string };
export type AcquireRequest = { databaseId: string; attemptId: string; holder: string; branch: string; startingCommit: string };
export type WorkspaceOptions = {
  repository: GitRepository; poolRoot: string; receiptsDirectory: string;
  treehouse?: string; run?: Runner;
};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const sameAllocation = (a: Allocation, b: Allocation): boolean =>
  a.leaseId === b.leaseId && a.holder === b.holder && a.path === b.path && a.pool === b.pool && a.repository === b.repository && a.branch === b.branch && a.startingCommit === b.startingCommit;
function allocation(value: unknown): value is Allocation {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return ["leaseId", "holder", "path", "pool", "repository", "branch", "startingCommit"].every(key => nonempty(row[key]))
    && isCommit(row.startingCommit as string) && isAbsolute(row.path as string) && isRef(`refs/heads/${row.branch as string}`);
}
export function startingBranch(databaseId: string, attemptId: string): string {
  return `docket-starting-points/${createHash("sha256").update(JSON.stringify([databaseId, attemptId])).digest("hex")}`;
}

/** Treehouse owns live leases. Immutable receipts only retain the verified acquisition's starting commit,
 * which Treehouse's status protocol does not expose. A receipt alone never establishes a live lease. */
export class TreehouseWorkspace {
  readonly options: WorkspaceOptions;
  readonly run: Runner;
  constructor(options: WorkspaceOptions) {
    if (!isAbsolute(options.poolRoot) || !isAbsolute(options.receiptsDirectory)) throw new Error("Pool and receipt paths must be absolute");
    this.options = options;
    this.run = options.run ?? commandRunner();
  }
  private command(args: string[]): Promise<Command> {
    return this.run(this.options.treehouse ?? "treehouse", ["--root", this.options.poolRoot, ...args], this.options.repository.options.repository);
  }
  private receipt(leaseId: string): string {
    return join(this.options.receiptsDirectory, `${createHash("sha256").update(leaseId).digest("hex")}.json`);
  }
  async recyclableRoots(): Promise<Result<string[]>> {
    try { return confirmed([await realpath(this.options.poolRoot)]); }
    catch (error) { return uncertain("Pool root could not be resolved", String(error)); }
  }
  /** Pool identity follows Treehouse's origin URL (or canonical repository path when there is no origin). */
  private async identity(): Promise<Result<{ pool: string; repository: string; root: string }>> {
    const repo = this.options.repository;
    const repository = await repo.identity();
    if (repository.status !== "confirmed") return repository;
    const origin = await repo.command(["remote", "get-url", "origin"]);
    if (!origin.complete || ![0, 2].includes(origin.code!) || (origin.code === 0 && !nonempty(origin.stdout.trim()))) return uncertain("Pool origin is unknown", origin);
    try {
      const root = await realpath(this.options.poolRoot);
      const backing = await realpath(repo.options.repository);
      const pool = JSON.stringify(origin.code === 0 ? { root, origin: origin.stdout.trim() } : { root, repository: backing });
      return confirmed({ pool, repository: repository.value, root });
    } catch (error) { return uncertain("Pool identity could not be resolved", String(error)); }
  }
  private async rows(): Promise<Result<LeaseObservation[]>> {
    const read = await this.command(["status", "--json"]);
    if (!read.complete || read.code !== 0) return uncertain("Treehouse listing failed", read);
    try {
      const rows: unknown = JSON.parse(read.stdout);
      if (!Array.isArray(rows)) throw new Error("Expected complete array");
      const leases: LeaseObservation[] = [];
      const paths = new Set<string>(), ids = new Set<string>();
      for (const row of rows) {
        if (typeof row !== "object" || row === null || !nonempty(row.path) || !isAbsolute(row.path)
          || typeof row.branch !== "string" || typeof row.lease_id !== "string" || typeof row.lease_holder !== "string") throw new Error("Malformed Treehouse row");
        if (paths.has(row.path)) throw new Error("Duplicate Treehouse path");
        paths.add(row.path);
        if (row.lease_id === "") { if (row.lease_holder !== "") throw new Error("Holder without lease"); continue; }
        if (!nonempty(row.lease_holder) || !nonempty(row.branch) || ids.has(row.lease_id)) throw new Error("Incomplete or duplicate lease");
        ids.add(row.lease_id);
        leases.push({ leaseId: row.lease_id, holder: row.lease_holder, path: row.path, branch: row.branch });
      }
      return confirmed(leases);
    } catch (error) { return uncertain("Malformed Treehouse listing", { read, error: String(error) }); }
  }
  async list(): Promise<Result<Allocation[]>> {
    const identity = await this.identity();
    if (identity.status !== "confirmed") return identity;
    const rows = await this.rows();
    if (rows.status !== "confirmed") return rows;
    const found: Allocation[] = [];
    for (const row of rows.value) {
      let receipt: unknown;
      try { receipt = JSON.parse(await readFile(this.receipt(row.leaseId), "utf8")); }
      catch (error) { return uncertain("Listed lease has no readable acquisition receipt", { row, error: String(error) }); }
      if (!allocation(receipt)) return uncertain("Malformed acquisition receipt", row);
      const inspected = await this.inspect(receipt);
      if (inspected.status !== "confirmed") return inspected;
      if (inspected.value.state !== "matching") return uncertain("Listed allocation did not match its acquisition", inspected);
      found.push(inspected.value.allocation);
    }
    const after = await this.identity();
    if (after.status !== "confirmed" || after.value.pool !== identity.value.pool) return uncertain("Pool changed during listing", after);
    return confirmed(found);
  }
  async inspect(expected: Allocation): Promise<Result<LeaseInspection>> {
    if (!allocation(expected)) return rejected("A full allocation identity is required", expected);
    const identity = await this.identity();
    if (identity.status !== "confirmed") return identity;
    if (identity.value.pool !== expected.pool) return uncertain("Allocation belongs to a different pool", { expected, current: identity.value });
    if (identity.value.repository !== expected.repository) return confirmed({ state: "mismatch", reason: "Repository identity differs" });
    const rows = await this.rows();
    if (rows.status !== "confirmed") return rows;
    const row = rows.value.find(row => row.leaseId === expected.leaseId);
    if (!row) return confirmed(rows.value.some(row => row.path === expected.path) ? { state: "mismatch", reason: "Path has a different lease" } : { state: "absent" });
    if (row.path !== expected.path || row.holder !== expected.holder || row.branch !== expected.branch) return confirmed({ state: "mismatch", reason: "Live lease identity differs" });
    try {
      const saved: unknown = JSON.parse(await readFile(this.receipt(expected.leaseId), "utf8"));
      if (!allocation(saved)) return uncertain("Malformed acquisition receipt", expected);
      if (!sameAllocation(saved, expected)) return confirmed({ state: "mismatch", reason: "Verified acquisition identity differs" });
      const path = await realpath(expected.path);
      if (path !== expected.path || !inside(identity.value.root, path) || path === identity.value.root) return confirmed({ state: "mismatch", reason: "Path is not canonical inside this pool" });
    } catch (error) { return uncertain("Acquisition identity could not be read", String(error)); }
    const repo = await this.options.repository.identity(expected.path);
    if (repo.status !== "confirmed") return repo;
    if (repo.value !== expected.repository) return confirmed({ state: "mismatch", reason: "Workspace belongs to a different repository" });
    const workspace = await this.options.repository.inspectWorkspace(expected.path);
    if (workspace.status !== "confirmed") return workspace;
    if (workspace.value.branch !== `refs/heads/${expected.branch}`) return confirmed({ state: "mismatch", reason: "Checked-out branch differs" });
    const after = await this.identity();
    if (after.status !== "confirmed" || after.value.pool !== expected.pool) return uncertain("Pool changed during inspection", after);
    return confirmed({ state: "matching", allocation: expected });
  }
  async acquire(request: AcquireRequest): Promise<Result<Allocation>> {
    if (![request.databaseId, request.attemptId, request.holder].every(nonempty) || request.holder.startsWith("-") || !isRef(`refs/heads/${request.branch}`) || !isCommit(request.startingCommit)) return rejected("Invalid acquisition request", request);
    try { await mkdir(this.options.poolRoot, { recursive: true }); await mkdir(this.options.receiptsDirectory, { recursive: true }); }
    catch (error) { return uncertain("Workspace storage could not be prepared", String(error)); }
    const identity = await this.identity();
    if (identity.status !== "confirmed") return identity;
    const receipts = await realpath(this.options.receiptsDirectory);
    if (inside(identity.value.root, receipts)) return rejected("Acquisition receipts must be outside recyclable roots");
    const base = startingBranch(request.databaseId, request.attemptId);
    const ref = `refs/heads/${base}`;
    // Create-only: an interrupted earlier preparation requires reconciliation, not another get.
    const prepared = await this.options.repository.createPinnedRef(ref, request.startingCommit);
    if (prepared.status !== "confirmed") return prepared;
    const acquired = await this.command(["get", "--lease", "--json", "--no-fetch", "--lease-holder", request.holder, "--base", base, "--branch", request.branch]);
    if (!acquired.complete || acquired.code !== 0) return uncertain("Treehouse acquisition outcome requires inspection; do not retry", { acquired, ref, request });
    let row: { path: string; lease_id: string; lease_holder: string };
    try {
      row = JSON.parse(acquired.stdout);
      if (!row || !nonempty(row.path) || !isAbsolute(row.path) || !nonempty(row.lease_id) || row.lease_holder !== request.holder) throw new Error("Incomplete allocation or wrong holder");
    } catch (error) { return uncertain("Malformed or mismatched Treehouse allocation", { acquired, error: String(error), ref }); }
    const value: Allocation = { leaseId: row.lease_id, holder: request.holder, path: row.path, branch: request.branch, startingCommit: request.startingCommit, pool: identity.value.pool, repository: identity.value.repository };
    const workspace = await this.options.repository.inspectWorkspace(value.path);
    const repository = await this.options.repository.identity(value.path);
    const listed = await this.rows();
    const after = await this.identity();
    if (workspace.status !== "confirmed" || workspace.value.head !== request.startingCommit || workspace.value.branch !== `refs/heads/${request.branch}`
      || repository.status !== "confirmed" || repository.value !== value.repository || listed.status !== "confirmed"
      || !listed.value.some(row => row.leaseId === value.leaseId && row.holder === value.holder && row.path === value.path && row.branch === value.branch)
      || after.status !== "confirmed" || after.value.pool !== value.pool) return uncertain("Acquired allocation did not verify", { value, workspace, repository, listed, after, ref });
    try {
      if (await realpath(value.path) !== value.path || !inside(identity.value.root, value.path) || value.path === identity.value.root) return uncertain("Acquired path is outside its canonical pool", value);
      // Exclusive immutable receipt, never an alternative lease registry.
      await writeFile(this.receipt(value.leaseId), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    } catch (error) { return uncertain("Verified acquisition could not be retained", { value, error: String(error), ref }); }
    const cleanup = await this.options.repository.conditionalDeleteRef(ref, request.startingCommit);
    if (cleanup.status !== "confirmed") return uncertain("Allocation verified but starting-ref cleanup requires inspection; moved refs are preserved", { value, cleanup, ref });
    return confirmed(value);
  }
  async returnLease(expected: Allocation, request: { authorised: true; requestId: string; retention: RetentionRequest }): Promise<Result<{ returned: true }>> {
    if (request.authorised !== true || !nonempty(request.requestId)) return rejected("An authorised core return request is required");
    const inspected = await this.inspect(expected);
    if (inspected.status !== "confirmed") return inspected;
    if (inspected.value.state !== "matching") return rejected("Allocation does not match the live lease", inspected.value);
    const roots = await this.recyclableRoots();
    if (roots.status !== "confirmed") return roots;
    // Recheck required deliverables immediately before Treehouse's conditional return.
    const retained = await this.options.repository.verifyRetention({ ...request.retention, workspace: expected.path, recyclableRoots: [...request.retention.recyclableRoots, ...roots.value] });
    if (retained.status !== "confirmed") return retained;
    const returned = await this.command(["return", "--if-lease-holder", expected.holder, "--if-lease-id", expected.leaseId, expected.path]);
    const identity = await this.identity();
    const rows = await this.rows();
    if (identity.status !== "confirmed" || identity.value.pool !== expected.pool || rows.status !== "confirmed" || !returned.complete) return uncertain("Lease return outcome is unknown", { returned, identity, rows });
    if (returned.code === 0 && !rows.value.some(row => row.leaseId === expected.leaseId || row.path === expected.path)) return confirmed({ returned: true });
    if (returned.code !== 0 && rows.value.some(row => row.leaseId === expected.leaseId && row.path === expected.path)) return rejected("Treehouse refused lease return", returned);
    return uncertain("Lease return could not be confirmed", { returned, rows });
  }
}
