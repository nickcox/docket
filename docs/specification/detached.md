# Detached task execution

Status: required behaviour for the next execution workflow, not a description of the installed CLI. The operation names below describe behaviour; they do not prescribe command spelling. The first milestone is detached delivery by fast-forward and by approval. The first release also includes PR delivery. Requirements R41–R53 and scenarios D01–D09 are normative for this workflow.

## Scope and transition

**R41.** Docket owns objectives, the task DAG, attempts, checks, delivery and worktree allocation and return. The host runs the worker independently of the process that submitted it. bb is the first host; additional hosts are planned. Pi is a candidate, not a requirement for this release. A launcher supplies submission and observation by worker reference. A thread ID is specific to bb; it is not part of the task graph, check policy or repository delivery contract. Docket runs no background process of its own: work moves forward when `sync` runs (R44).

Use freshly initialised contexts. Do not migrate, resume or delete existing contexts, attempts or worktrees. The old command catalogue describes the foreground implementation until cutover. Until then, the foreground workflow, including its standalone Pi launcher, remains the supported way to dispatch work, so changes made during the transition must not break it.

The detached path does not require a foreground owner, a heartbeat from the submitting CLI, a general external-effect replay protocol or a restricted Pi supervisor. Its only supervisor decision about an attempt's result is the approval policy (R45); there is no other acceptance operation. Budget enforcement, durable questions, independent review and automatic rebase are not requirements of this release. A worker asks questions in its host thread, and the person answers there.

## Supervisor operations

| ID | Operation | Required behaviour |
| --- | --- | --- |
| R42 | Dispatch an objective | Select ready tasks for this objective in project order, up to the remaining **project-wide** worker capacity. Reserve a task and its slot atomically. Assign an attempt ID, branch and worktree; record the allocation, chosen launcher and resolved delivery policy. Submit the task, record the outcome and any worker reference, then return without waiting for completion. Report each attempted submission separately. Exiting the CLI must not stop an accepted worker. |
| R43 | Continue from an earlier attempt | Dispatch a new attempt of the same task, starting from a named commit on an earlier attempt's branch, with an optional note added to the task instructions. Refuse a commit that is not on that branch. The new attempt has its own ID, branch and worktree, and is reserved and submitted as for dispatch. The earlier attempt and its branch are preserved. |
| R44 | Sync an objective | Observe outstanding attempts through their recorded launcher, even if the project default has changed. Record observation time and result. Check finished work, apply its delivery policy, observe published PRs and return eligible worktrees. A bounded check may take time; do not wait for an active worker to finish, an approval to arrive or an open PR to merge. Do not dispatch newly ready tasks. |
| R45 | Approve an attempt | Only for an attempt under the approval policy whose checks have passed. Record the supervisor's approval of the exact checked commit, then deliver and return the worktree as sync would. Refuse approval of any other commit. If the operation is interrupted after recording approval, the next sync completes delivery. |
| R46 | Read objective status | Read recorded state only, without constructing a launcher or inspecting Git or Treehouse. Show ready tasks, assignments, unmet dependency IDs and reasons for attention, including attempts awaiting approval with their checked commit. Include last observation time and the attempt, worktree, branch, worker and PR references where known. Report worker result, checks, delivery and worktree return separately. A last observation is not a claim about live state. |

**R47.** Do not start the same task twice because two supervisors dispatched concurrently. A retry has a distinct attempt ID and preserves the earlier attempt. A definite submission refusal releases the worker slot. A possibly successful submission with a lost reply holds its slot and requires attention; do not resend blindly. A worker known to have stopped no longer occupies worker capacity, even if the task retains a worktree. A task awaiting checks, approval, delivery or merge is not eligible for a new worker just because its slot is free.

## Triggering sync

**R44** (continued). The supervisor can run sync at any time. A host may also run it when it observes a worker turn end. For bb, the Docket plugin runs sync for the attempt's objective when a Docket worker's turn ends. bb lifecycle events are notifications: they cannot block anything, and events missed while the plugin is unloaded are not replayed. A missed or failed trigger therefore only delays work until the next sync. Sync must give the same result whether the plugin, the supervisor or both run it, including at the same time.

## Checks, delivery and dependencies

**R48.** Use the project delivery policy unless the task explicitly overrides it. Record the resolved choice on the attempt. Run project-controlled checks in the attempt worktree only after the worker has reported a successful result and stopped using the worktree. Bind the result to the commit checked. Failure keeps the worktree, names the failed check and gives the supervisor access to its diagnostics. If the candidate changes, check the new commit before delivery.

**R49.** Each policy delivers the checked commit and satisfies code dependencies as follows. The approval policy is also R45.

| Policy | Delivery | Dependency satisfied when |
| --- | --- | --- |
| Fast-forward | Fast-forward the configured target to the checked commit. If it diverged, retain the output and report that an update is needed. Do not force-update or automatically rebase. | The target from which dependent work starts contains the checked change. |
| Approval | After checks pass, wait for the supervisor to approve the checked commit. Then deliver it as for fast-forward. A changed candidate needs fresh checks and a new approval. Until approval, the attempt holds its worktree but no worker slot. | As for fast-forward. |
| Pull request | Push the checked commit and open a PR against the configured target. Record the PR reference. A changed PR head does not inherit the earlier pass. A PR closed without merge requires attention. | The PR is merged and the integrated change is available from the refreshed target used to start dependants. A squash merge need not preserve the original commit ID. |

For a code dependency, neither a worker report nor a manual task-state change substitutes for availability of the change on the target. A cleanup failure does not reverse successful delivery. Independent attempts must continue to be processed if one needs attention.

## Worktree return and interrupted operations

**R50.** Automatically return a clean worktree only when its allocation still belongs to this attempt, the worker can no longer modify it, and the output is available elsewhere. For fast-forward and approval delivery that means confirmed integration; for PR delivery it means confirmed push and PR publication, not merge. Otherwise keep the worktree and report why. If a return fails after delivery, retry only cleanup. Never return another attempt's allocation.

**R51.** Overlapping syncs, and a sync overlapping an approval, must not duplicate delivery or cleanup. After an interrupted fast-forward, inspect the target; after an interrupted PR publication, look up the PR by source branch and target. If the outcome cannot be established, preserve what is known and request supervisor action rather than repeating the operation.

## bb workers

**R52.** A bb worker runs with the person's ordinary bb configuration: provider settings, skills, plugin instructions and context files. It also receives `BB_*` environment variables that let it run `bb` commands as itself. Docket does not isolate it. This is accepted for this release. Q2a in the [bb 0.49.0 qualification record](../qualification/bb-0.49.0.md#q2a--worker-identity-and-loaded-resources) lists what one worker loaded.

## bb qualification still required

**R53.** On a recorded bb/provider combination, submit in an assigned worktree, exit the submitting process and observe from a fresh process. Distinguish a valid result, an idle or failed turn, and release of the worktree, including whether another turn could modify it. Test a lost submission reply separately. Existing mock tests and an in-memory stop flag are not qualification evidence. If release cannot be established, require explicit supervisor confirmation before final checks or worktree return on that configuration. If the worker cannot run independently, do not claim detached support. Apply the same behavioural test when adding a second host.

The live foreground qualification of bb 0.49.0 with the Pi provider, in the [qualification record](../qualification/bb-0.49.0.md), already shows the following. It was not run with a detached dispatch, so it is evidence for the experiment's design, not detached qualification.

- A worker keeps running after the process that permitted it is killed (Q1a, attempt `153e387c`).
- A fresh process can read a thread by its stored reference, and with `ef336cd` person recovery treats a thread with no running turn that is idle, errored or archived as stopped.
- With the plugin enabled, the hook refuses ordinary later turns on a finished worker, including after a plugin reload and a bb restart. A turn that bypasses the hook is detected as a later turn before checks and acceptance (Q1b).
- bb refuses to delete an environment record while a live thread holds it, does not touch an attached worktree, and Docket can still read the worker after the record is deleted (Q2c, `f93c30b`).
- bb retries a held first prompt by itself when capacity frees, so admission can happen before the launcher's own recheck (attempt `9512b5fa`, fixed in `58177a0`).

The detached experiment still has to establish:

1. **Admission without an owner.** The foreground hook admits a first prompt only while the dispatching owner's heartbeat is fresh. A detached hook must admit it once on the recorded submission alone, with the submitting process already gone, including when bb retries the held prompt by itself.
2. **A lost submission reply.** The foreground run killed the dispatch before bb created a thread. Lose the reply after bb has created the thread, and find the worker by attempt ID without sending a second prompt.
3. **Release of the worktree.** Idle with no running turn shows that the worker has stopped, but a turn that bypasses the hook (Send now, a disabled plugin) can still start later. Establish whether rechecking the thread for later turns, and the candidate commit and worktree, before checks and again before delivery is enough to return the worktree automatically. If it is not, require supervisor confirmation as above.

## Acceptance scenarios

| ID | Set-up and observable outcome | Requirements |
| --- | --- | --- |
| D01 | A and B are ready; C depends on A and D on B. Capacity is two. A inherits this project's fast-forward default, B overrides it to PR. Dispatch returns distinct attempts, worktrees and worker references; both workers continue after the CLI exits. A concurrent dispatcher cannot duplicate either task or exceed capacity, including from another objective. | R41, R42, R47 |
| D02 | From a fresh session with bb unavailable, status shows both assignments, their last observations and the blockers for C and D. It performs no external work. | R46 |
| D03 | Sync observes A's success and release of the worktree, checks its commit and fast-forwards. C becomes ready but is not started by sync. Even if return fails, C can start from the updated target; a later sync retries cleanup without repeating delivery. | R44, R48, R49, R50 |
| D04 | B passes checks and opens one PR. Its clean worktree returns; D is still blocked. Merge the PR and sync. D can now start from the refreshed target containing B's change. Repeated sync neither publishes again nor returns a reassigned worktree. | R49, R50, R51 |
| D05 | Lose a submission reply. Status shows the uncertain attempt and any known references. No second prompt is sent. In a separate attempt, observe a result without establishing release: neither final checks nor automatic return proceeds on that observation. | R47, R48, R50, R53 |
| D06 | Fail a check, change a checked commit, diverge a fast-forward target or close a PR without merge. No case releases the code dependency. Report the specific reason, retain undelivered local output, and continue processing other tasks. | R48, R49 |
| D07 | E uses the approval policy and passes checks. Sync does not deliver it; status shows E awaiting approval with its checked commit, and E holds its worktree but no worker slot. Approval of a different commit is refused. After approval of the checked commit, the target contains it, the worktree returns and E's dependants become ready. Repeating the approval does not deliver again. | R45, R46, R47, R49, R51 |
| D08 | A bb worker's turn ends and the plugin runs sync while the supervisor runs sync too. Delivery and cleanup each happen once. With the plugin disabled, the attempt waits, and the next supervisor sync completes the same work. | R44, R51 |
| D09 | A worker stops with committed but unfinished output. Continue from that commit: the new attempt starts from it in a new worktree, the earlier attempt and branch remain, and a commit that is not on the earlier attempt's branch is refused. | R43 |

## Relationship to foreground requirements

For detached execution, R41–R53 and D01–D09 replace the foreground requirements and scenarios where they differ. R02/R04/R05 retain DAG ordering, atomic capacity and attempt allocation; readiness now depends on delivery. R06–R09 and R31–R34 are replaced on this path by submission, fresh-process observation, bounded recovery and the qualification above, not a live owner. R10/R11 and R15/R16 retain commit-specific checks and identified worktree return, with delivery, or approval followed by delivery, rather than separate acceptance. R12 is retained as continuation from an earlier attempt's commit (R43). R13, R14, R20 and R21 are not required for this release. R35 is deferred. The old release requirement that PR support follow the first release does not apply. Unchanged task management, CLI envelope and storage integrity rules remain in their existing chapters.

At cutover, merge this chapter into the domain, contracts, adapters and acceptance chapters, remove the foreground requirements it replaces and the notes at the top of each chapter that point here, and delete this file. The specification must not describe two workflows after cutover.
