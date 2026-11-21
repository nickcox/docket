# Detached execution implementation plan

The approach is to **keep the repository and the parts that manage project work, write a new execution workflow in that repository, then remove the foreground workflow.** Splitting `src/dispatch.ts` at a convenient line is not enough, because some of its assumptions are also present in reservation, bb admission, checks and workspace return. The required behaviour is in [detached task execution](../specification/detached.md) (R41–R53, D01–D09); this plan does not restate it. [The findings](detached-execution-findings.md) record what the existing code does and which parts to keep.

## Rationale

Docket should own the task graph and the decisions that depend on it. It should know which tasks are ready, which worktree belongs to each attempt, what checks a commit must pass, how to deliver it, and when a dependent task can start. Those are good reasons to keep the existing codebase. They are not reasons for a Docket process to stay alive for the lifetime of every worker.

bb will be the first supported host. We intend to add other hosts, with standalone Pi a likely next candidate. The distinction is practical: the launcher knows how to start and observe a worker; Docket knows what to do with the result. We will prove that distinction with bb, not design multiple implementations in advance. For uncommon failures, the default will be to preserve the branch or worktree, show the supervisor what happened and let it decide. We will keep stronger controls where a small mistake would affect other tasks, such as dispatching the same task twice or returning a worktree that has already been reassigned.

## 1. Decide what stays, what changes and what goes

| Area | Implementation decision |
|---|---|
| Objectives, tasks and dependencies | **Keep.** Reuse task identities, dependency edges, ordering and existing task management commands. Change readiness only where it must account for delivery. |
| SQLite, CLI and configuration | **Keep the foundation.** Reuse context setup, transactions, CLI response format and operation catalogue. Do not preserve a field or configuration requirement solely because the foreground runner needs it. |
| Git, Treehouse and project check policy | **Reuse the underlying operations.** Keep branch inspection, worktree allocation and return, policy loading and command execution. Replace higher-level functions if they require the old acceptance or owner protocol. |
| Reservation and dispatch | **Replace the execution path.** Keep atomic task reservation and capacity accounting. Do not make new dispatch construct a fictitious owner, heartbeat or evidence record to call an old function. |
| bb execution | **Adapt, do not simply reuse.** Keep useful bb commands and reference parsing. The synthetic probes were removed in `d0945e0`; the [bb 0.49.0 qualification record](../qualification/bb-0.49.0.md) is the live evidence to start from. Replace admission or observation code that relies on the submitting process staying alive. |
| Completion | **Replace the coordination logic.** A checked commit is delivered according to the attempt’s policy: fast-forward, approval or PR. The approval policy is the only supervisor decision about a result; do not silently invoke a separate review or person-acceptance workflow underneath it. |
| Continuation | **Keep.** Starting a new attempt from a commit on an earlier attempt’s branch stays supported. Questions do not: a bb worker asks in its thread. |
| Pi and other foreground-only features | **Defer support.** Do not make the new path load Pi configuration or implement Pi-specific operations. Until cutover, the foreground Pi launcher is how Docket’s own tasks are dispatched, so do not break it. After cutover every worker is a bb thread, which loads the person’s ordinary bb configuration and is not isolated the way the private Pi home was. Retire old features and tests deliberately after their replacement is proven. |

The rule for each function is: **reuse it if its inputs describe something the new workflow actually knows.** For example, keeping the code that runs a configured check command is useful. Manufacturing an old-style acceptance record just to reach that code is not.

## 2. Revise the specification and settle the transition

**Done, apart from the bb-specific parts.** [Detached task execution](../specification/detached.md) is the public contract: dispatch (R42), continue (R43), sync and its host trigger (R44), approve (R45) and read-only status (R46), with the delivery policies in R49. The exact command spelling can follow the existing CLI conventions. Each foreground chapter has a note pointing to it, and the requirement index lists R41–R53. The specification's [relationship section](../specification/detached.md#relationship-to-foreground-requirements) lists the foreground requirements that no longer apply, including the owner heartbeat, the separate acceptance operation and the general external-effect recovery protocol.

What remains:

- Keep the existing tests until the corresponding implementation is changed, but mark which behaviours the new specification replaces. Otherwise a developer fixing a failing test may accidentally restore the behaviour we meant to remove.
- After the experiment in section 3, settle R53 and the admission, lost-reply and worktree-release rules it leaves open.
- **Storage decision:** start with freshly initialised contexts. Document how to initialise one. No migration of existing databases, attempts or retained worktrees is required; leave old contexts untouched.

## 3. Prove the one uncertain dependency: detached bb execution

Before rewriting dispatch, run an experiment against a real bb/provider combination in a disposable repository. Start from `src/adapters/bb.ts`, `docs/bb-launcher.md` and the [bb 0.49.0 qualification record](../qualification/bb-0.49.0.md). That foreground qualification already shows that a worker keeps running after its dispatch is killed, that a fresh process can read a thread by reference and recognise a stopped one (`ef336cd`), that the hook refuses ordinary later turns and Docket detects a bypass, and that bb leaves an attached worktree alone (`f93c30b`). The [detached specification](../specification/detached.md#bb-qualification-still-required) lists this evidence. The experiment only needs to settle what remains:

1. **Admission without an owner.** Acquire a Treehouse worktree, submit a task with an attempt ID that a second process can recognise, record its bb thread reference, then exit the submitting process. Change the hook so it admits the first prompt once on the recorded submission alone, not on a fresh owner heartbeat. Confirm it admits once, including when bb retries the held prompt by itself, and that the worker runs in the assigned worktree.
2. **A lost submission reply.** Lose the reply after bb has created the thread. From a fresh process, find the worker by attempt ID without sending a second prompt.
3. **Release of the worktree.** From a fresh process, recover the result and output commit. Test an idle thread with no result and a failed worker. Then start a later turn by a path that bypasses the hook, and establish whether rechecking the thread, the candidate commit and the worktree before checks and before delivery catches it reliably.
4. Record the tested bb/provider version, observations and limitations in `docs/qualification/`.

**Exit criterion:** a fresh process can reliably identify a completed attempt and establish when final checks and worktree reuse are appropriate. If bb can establish completion but not release of the worktree, document the limitation and require supervisor confirmation for that case. If the worker cannot run independently at all, resolve that before doing the rest of the refactor. A background Docket process per attempt is not the fallback.

## 4. Introduce the new attempt operations inside the existing repository

Use `src/storage/tasks.ts`, `src/storage/reservations.ts`, `src/storage/database.ts` and the existing schema as the starting point. Implement the few storage operations the new workflow needs rather than copying the old reservation sequence into a new module.

- **Reserve one ready task.** In one short SQLite transaction, select an eligible task, verify its dependencies, check project-wide capacity and create its attempt. Do not hold the transaction while calling Git, Treehouse or bb.
- **Record the resources as they become known.** Persist the starting commit, attempt branch and worktree allocation before submitting the worker. Persist the launcher name, worker reference and submission outcome. A later `sync` uses the recorded launcher, not the project’s current default.
- **Record completion in separate facts.** Keep the worker outcome, checked commit and check result, delivery reference, and worktree return status. Avoid a single `done` flag that has to stand for all four.
- **Keep attempts distinct.** Retrying a task creates a new attempt; the supervisor can still inspect the previous branch, thread or failure.

Three rules should have direct storage tests:

1. Two dispatchers cannot reserve the same task or exceed the project limit, even when dispatching different objectives.
2. A stopped worker releases its worker slot. Its failed check may still occupy a worktree. An uncertain submission continues to count against capacity until resolved.
3. For code tasks, dependants become ready when the change is available from their starting target. Neither worker success nor an open PR satisfies that condition.

Use real temporary SQLite for these tests. Do not rewrite unrelated task and objective operations to use a new data model.

## 5. Implement detached dispatch and read-only status

Write a small new dispatch implementation beside the old one while developing it. Give it only the dependencies it needs: task reservation, repository inspection, worktree allocation and launcher submission. Do not copy the imports and lifecycle from `src/dispatch.ts`.

For each available slot:

1. Reserve a ready task and resolve its profile, check policy and delivery policy.
2. Create its attempt branch and acquire its worktree. Record the allocation. If setup definitely fails before submission, release the worker slot and report any resource still needing cleanup.
3. Call the launcher with the attempt ID, instructions and assigned worktree.
4. On confirmed submission, record and return the worker reference. On definite refusal, release the slot. On an uncertain reply, retain the reservation, report `needs attention` and **do not submit again automatically**.
5. Return outcomes for all tasks considered. Failure to start the second task must not hide the successful submission of the first.

Narrow `src/adapters/launcher.ts` for this path to submission and fresh-process observation. bb thread interpretation belongs in `src/adapters/bb.ts`. In `src/runtime.ts`, construct only the services the operation requires: a status read should not require bb, Git, Treehouse, Pi or check execution profiles to be available.

Implement status at the same time as dispatch. A supervisor should see what can start, what is running, what is blocked and why, and what needs attention. Include task and attempt IDs, launcher and worker reference, branch, worktree, delivery reference and last observation time where applicable.

**Exit criterion:** submit two tasks to bb, terminate the CLI, and list both from a new CLI process. A second dispatch must not create duplicate workers. No foreground owner or keep-awake process remains on behalf of the submitting CLI.

## 6. Implement `sync` for checked fast-forward and approval delivery

Start with fast-forward and approval delivery so there is one complete, useful workflow before adding PR support. Approval is the same delivery with one recorded decision in front of it: after checks pass, `sync` leaves the attempt awaiting approval, and `approve` records approval of the exact checked commit and then delivers. Use it for repositories where the supervisor reviews each change before it reaches the target, as is done for Docket itself today.

1. **Observe.** For each outstanding attempt, use its stored launcher reference. If it is running, update the observation time and move on. If it failed, record the failure and retain the worktree. If the observation is ambiguous, say what is unknown.
2. **Check.** Once a successful worker has stopped using the worktree, identify its output commit and run the required project-controlled checks there. Inspect `src/checks.ts` for reusable execution and result handling. Record the commit that passed and the location of failure diagnostics. A failed check on one attempt must not prevent observation of the others.
3. **Deliver.** For the approval policy, deliver only once approval of this exact commit is recorded. Reuse the repository adapter to fast-forward the configured target to the checked commit. If the candidate has changed, require fresh checks. If the target has diverged, leave both branches intact and tell the supervisor they need updating. Do not force-update, automatically rebase or introduce a separate acceptance step.
4. **Return.** After integration, return the clean worktree through Treehouse if it still belongs to the attempt. If return fails, record **delivered, worktree retained**. The dependent task can start; a cleanup retry must not redeliver the commit.

Add the bb plugin trigger: when a Docket worker’s turn ends, the plugin runs `sync` for that attempt’s objective. Prevent two `sync` processes, or `sync` and `approve`, from acting on the same attempt at the same time. Use a short transaction to record which invocation is handling it; never hold the database transaction during checks or Git operations. If that invocation dies, inspect the specific outcome before continuing. For example, if the target already contains the checked commit, record delivery instead of trying again. Where inspection cannot settle the question, show the supervisor the interrupted action. Do not build a general replay engine.

**First milestone:** two independent bb workers survive CLI exit; a fresh supervisor observes them, runs checks, delivers eligible commits and returns their worktrees. One of them uses the approval policy and is delivered only after `approve`. Include a diverged target in the test: one successful fast-forward must not cause the other worker’s changes to be overwritten.

## 7. Switch the CLI and remove the foreground workflow

Do this **after the fast-forward milestone**, not after implementing Pi or every planned feature. The old and new implementations may coexist in development, but they must not become two permanent modes.

- Route the execution operations through `src/catalog.ts`, `src/operation-schemas.ts` and `src/operations.ts`. Update the README and CLI examples. Make the change in dispatch semantics explicit: success now reports submission, not completion.
- Remove the old foreground dispatch route and the calls that wait, heartbeat, fence, check and accept on its behalf. Remove obsolete dependencies from `src/runtime.ts`. Check call sites before deleting shared Git, Treehouse, check or storage functions.
- Remove unsupported commands from the catalogue rather than leaving commands that accept input but cannot perform useful work. Remove corresponding configuration prerequisites. In particular, bb-only operation must not require a configured Pi installation.
- Keep continuation from an earlier attempt’s commit, moved onto the new dispatch path.
- Merge the detached chapter into the rest of the specification, remove the foreground requirements it replaced and the notes pointing to it, and delete `docs/specification/detached.md`, as its last paragraph requires. Move `docs/plans/` content that is still useful into the specification or the qualification record, and delete the rest.
- Review the tests by **behaviour**, not by file. Keep reservation races, exact-commit checks, non-fast-forward refusal, uncertain submissions and safe worktree return. Replace tests that assume the dispatching caller remains alive. Delete tests for retired requirements along with the implementation they protected.
- Keep useful Pi adapter code only where it can remain isolated from the supported runtime. Git history is sufficient for code that otherwise requires ongoing compatibility work.

**Exit criterion:** trace the released `dispatch`, `continue`, `sync`, `approve` and `status` paths from the CLI. None should enter the old foreground workflow or manufacture its claims or acceptance records. A new contributor should find one supported way to execute a task.

## 8. Add PR delivery and dependency handling

Select one repository hosting service and supported CLI. Put PR publication and lookup behind a repository-hosting adapter, separate from the **worker** launcher. The same PR implementation must work for a bb worker and, later, a Pi worker.

- Push the checked commit on the attempt branch and open a PR against the configured target. Store the PR reference. If publication was interrupted, look up the existing PR by source branch and target before creating another.
- Return the worktree once the checked output is on the remote, the PR exists and the normal return conditions hold. Show the task as `awaiting merge`; it occupies neither a worker slot nor a worktree.
- On subsequent syncs, distinguish open, merged and closed without merge. Only a merged change satisfies the dependency. Refresh the target used for new worktrees before dispatching dependent work, including when the service used a squash merge.
- If the PR head changes after Docket checked it, do not describe the replacement commit as checked. Report the change and require fresh checks or supervisor action.

For ordinary recovery, the supervisor needs to be able to inspect, retry a check or delivery, retry a worktree return, and explicitly abandon or discard an attempt. Reuse suitable existing operations. Do not require the supervisor to manipulate internal request or claim records.

## 9. Verify the release and define the next-host test

Use one release scenario that exercises the distinctions most likely to break. Give an objective two independent tasks, **A** and **B**, with **C** depending on A and **D** depending on B. Set capacity to two. A uses fast-forward delivery; B uses a PR. Approval delivery is covered by the first milestone in section 6 and by scenario D07.

1. Dispatch A and B, close the CLI, and inspect both attempts from a fresh supervisor.
2. Sync after completion. A passes checks and integrates. B passes checks and opens exactly one PR. Both worktrees return.
3. Dispatch C from a target containing A. Status still names B’s open PR as the reason D cannot start.
4. Merge B’s PR and sync. Dispatch D from a refreshed target containing B’s changes.
5. Sync again after one returned worktree has been reassigned. Verify that Docket neither repeats delivery nor returns the new occupant’s worktree.

Use pure tests for readiness and policy decisions, real temporary SQLite with a fake launcher for scheduling, and real Git and Treehouse for their respective behaviours. Retain the real bb restart experiment as an integration test or documented qualification run. Run the repository type check and full test suite at each cutover.

**Pi comes after this release.** Its admission test is concrete: a Pi worker can be started in an assigned worktree, the submitting CLI can exit, and a fresh invocation can identify the result and establish whether the worktree is available for checks and return. Adding Pi should require a launcher, configuration and host-specific tests, **not changes to the DAG, capacity rules, check policy or delivery workflow**.
