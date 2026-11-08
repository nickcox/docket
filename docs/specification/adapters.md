# Adapters and host qualification

Status: draft, part of the [Docket specification](README.md).

## Ownership boundaries

**R36.** The core owns database facts, readiness, specifications, authority, evidence, retention decisions and request/effect state. Treehouse owns actual leases; Git owns refs/worktrees; a launcher owns its worker and session state; a host owns conversations, transport, scheduling and UI.

The CLI is the public integration contract. Application operations are internal; the bb plugin invokes them through the CLI/binding transport. No SQLite writes or duplicated domain decisions in the plugin. A host event prompts a fresh owner read, not an authoritative task transition.

There is no independent task queue, speculative next-task dispatcher, worker adoption, automatic worker restart, mailbox or durable scheduling service in the core. Requests execute only explicitly authorised work. Supervisors can ask for a new attempt; host retry/turn recovery cannot silently turn that into replay of an old worker.

## Launchers

**R31.** A launcher starts a worker, sends it messages, observes it and stops it. Version 1 has two launchers: `pi` runs Pi as a separate process, and `bb` runs the worker as a bb thread. The launcher interface provides:

| Method | Contract |
| --- | --- |
| capabilities(profile) | Supported preparation/admission, active steering, after-turn message, stop-turn, terminal stop/fence, usage metrics, resource isolation and observation sources |
| prepare(binding, effectId) | Create a non-acting worker/session, or equivalent protected preparation; return a reference or definite rejection/uncertainty |
| activate(reference, storedInput, effectId, claimGeneration) | Admit exactly one initial task prompt after reference binding and launch permission |
| inspect(reference) | Current worker/turn/terminal state and capabilities, or unknown; no prompting |
| deliver(reference, message, mode, effectId) | At most one send attempt, never restart a terminal worker; report unsupported or uncertainty explicitly |
| stop(reference, effectId) | Request cancellation/termination; prove terminal state separately |
| fence(reference, effectId) | Establish that no future turn for this attempt can run; not merely an in-memory flag |
| usage(reference) | Session-attributed cumulative metrics with reported/unknown/unsupported status |
| result(reference) | Retained regular-file/result transport reference, not acceptance |

Every binding carries attempt/database identity, profile digest, allocation, internal session UUID and owning claim. A source observation has a stable source ID/sequence. Duplicate/out-of-order data cannot move state backwards or attach to a different attempt. Launcher-specific types stay inside adapters.

Adapter effects return confirmed(value), rejected(reason,evidence), or uncertain(reason,referenceHints). Inspect returns absent only after complete successful lookup. No adapter hides SDK retries that might activate/send twice. Unsupported operations refuse before effect. Preparation/activation/terminal semantics are each tested for every launcher.

A worker's environment contains only `PATH`, `HOME`, `TMPDIR` and `LANG`; the proxy variables `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY` when the host sets them; the credentials its profile references; and any further variable names that its execution profile lists in person-controlled host configuration. No `DOCKET_` variable is passed to a worker. The rest of the environment of the process that starts the worker is not inherited.

## Workspaces and repository

**R32.** Workspace operations are acquire, inspect/list, recyclableRoots and return. Every allocation has leaseId, task holder, path, pool/repository identity, branch and starting commit. Return requires exact matching identity and an authorised core return request. A path alone cannot identify a lease. Missing listed leases in a different pool are unknown.

Treehouse is the first adapter for both launchers. Use a database/attempt-derived private starting ref when it requires a branch rather than a raw commit; create and remove it conditionally, verify acquired HEAD, and leave moved refs intact. An uncertain acquisition is never automatically repeated.

The repository interface provides inspectRef/workspace, compare/changedPaths, verifyRetention, createPinnedRef, conditionalFastForward, prepareRebase, conditionalMoveRef and conditionalDeleteRef. It distinguishes absent refs from failed reads. No Git process is started by a pure decision test.

Integration into a checked-out target must preserve its worktree and refuse dirty/untracked state; moving only the ref under a checked-out worktree is forbidden. Git's expected-old-value/fast-forward protection must detect a target move after planning. Rebase runs detached or under equivalent protection so conflicts do not move accepted refs.

Retention verifies exact Git reachability and retained regular artefacts outside recyclable roots. Required deliverables are rechecked immediately before returning a lease. Neither bb archive/delete nor a source branch disappearing can override that requirement.

Checks run in the attempt's own workspace after its worker is terminal, so they need no separate allocation.

## bb launcher

**R33.** Required workflow:

1. Core reserves attempt, acquires/verifies lease and records a launch request.
2. Plugin backend registers ownership and prepares a bb thread/environment. No task prompt may run yet.
3. Record the returned thread/reference and resource identity in the core. Conditionally permit launch under its owning claim.
4. Admit the exact activation effect once. Any replay through the supported dispatch path after admission is blocked or exposed as uncertain, never reprompted.
5. Use host events plus fresh reads to observe progress. At terminal candidate, validate result, establish durable no-later-turn fencing, confirm stopped state, then record terminal/completion facts.

Stored thread metadata can locate a candidate binding, but cannot authorise it. The core database plus trusted host provenance establishes authority. Another agent/plugin can edit metadata; a valid-looking object is insufficient. The hook must check every member of grouped queued messages, not merely the first row's origin.

A person's message to a worker is recorded as a steer request before delivery. A message from another agent is not a person action. While the Docket plugin is enabled, its hook rejects ordinary person messages, steers, follow-ups, provider retries, queue drains, unarchive/restart resumes and automatic continuations for a finished attempt.

An intent precedes each SDK create/send. If a response is lost, inspect stable thread/queue/timeline identifiers where available; no matching message does not prove non-delivery. Remain uncertain unless an owner proves what happened. New attempt creation after resolution is explicit.

The bb launcher guarantees admission and terminal fencing only while the Docket plugin is installed and enabled and messages pass through its hook. It must restore the fence after normal backend reload and server restart with the plugin enabled. Deliberately disabling, unloading or changing the plugin, or explicitly using bb Send now or `bb thread queue send` on a worker, is outside this guarantee: bb may admit queued or later messages without Docket checking them. These limitations must be visible in bb launcher documentation. The core must not treat idle/stopped alone as terminal evidence.

Workers use a dedicated, qualified execution profile. Inject only approved credentials, task inputs and required tools; validate exact cwd/provider/model and exclude unintended user/project settings, extensions and context sources where the profile promises isolation. Explicitly describe any remaining trusted-user capabilities. A normal unrestricted coding thread is not silently equivalent to an isolated Pi worker.

## bb host

**R34.** The backend launches and observes workers, and provides event/question delivery, a Treehouse environment provider and minimal status UI. It registers lifecycle handlers before reconciling tracked threads at startup. Reconciliation is read-only until matching authority/ownership is established; events missed while unloaded are not assumed replayed.

Environment create receives a recorded lease ID, verifies it in the core and returns its existing path without another acquisition. Repeated calls for the same allocation have the same result. Record database/task/attempt/lease identity and starting merge base. Environment removal calls core return rules; if unmet, refuse with a usable command. Archive/delete/cascade/removal retries must never destroy the path or run destructive teardown before the core authorises return.

Requested adapter settings are no automatic retirement, externally owned path and no host setup/teardown; verify their actual semantics against the pinned SDK. The bb Git view should compare against the attempt's actual starting commit where supported, with the base branch named and any difference explained. It must not silently compare inherited output as new task changes.

The backend fixes caller/config/objective/session/request identity before invoking catalogue tools. Person form submissions come from a verified person interaction; sender labels/metadata are not enough. Agent tools return compact readable summaries to the person and full bounded structured data to the model.

Open person questions are visible before attempt details, retain choices and answer action after restart, and disappear only after the answer is recorded. Backend transports the answer through the same core operation as CLI. UI exposes no direct database actions.

Minimal UI shows objective progress, budget availability/spending, ready/held/running work, current candidates/checks/reviews, open questions, preserved leases, uncertain effects/claims and next actions. It can use existing bb environment/Git/PR interfaces; no custom board is required.

A bb supervisor thread is unrestricted unless a qualified provider removes all tools except the catalogue. Unrestricted sessions require an observing person; status/briefing records this limit. Unattended supervision can use restricted standalone Pi with bb workers. For that case, bb workers may be children of a dedicated labelled anchor thread rather than inventing a bb parent for a Pi conversation; core objective/session links remain authoritative.

Register one backend/process claim as needed for long-lived database access and per-resource worker claims for its active attempts. If the backend stops, unresolved claims block new work. Heartbeat expiry does not reassign them. The process code/config version remains fixed while operating; context reconfiguration/upgrades require explicit quiescence.

## Standalone Pi

**R35.** Pi runs one process and a new internal session per attempt, using the exact leased cwd/model/profile, controlled resource loading and the qualified RPC/result-file protocol. Bind reference/launch permission before sending the task prompt. A lost prompt acknowledgement causes uncertainty/failure and no second prompt. End-of-turn is separate from child exit.

The standalone CLI can wait for an explicitly dispatched attempt, record observations, run common completion/check operations and return control. A supervisor host can start one owner process per requested worker and continue receiving events; detached process launch uses the same effect protocol. There is no independent ready-task scheduler.

The restricted Pi supervisor exposes only catalogue tools, with no general shell/read/write/network tools beyond those operations. It uses private session/input files, bounded briefings/notes, durable notifications/questions and session usage. Register restriction mode before its first model request. Unrestricted Pi supervision is optional and must be explicitly labelled.

Shutdown/error preserves outstanding event IDs and tool request keys. A fresh supervisor session starts with current briefing and pending notifications. It does not reconstruct authority from an old conversation or restart an existing worker.

Keeping the machine awake is a host service invoked once per active execution/check period where configured. Under bb, the bb host already holds a sleep assertion for as long as its server runs, so Docket's bb backend relies on it and starts no keep-awake helper of its own. The standalone Pi path, which has no such host, starts its own. Native helper failure warns in diagnostics without inventing termination. It is not a safety prerequisite, and closing a laptop may still suspend processes. Lost heartbeats remain uncertainty after wake.

## Qualification gates

Qualification records the exact bb, SDK and provider versions and checks their source/type contracts. The probes must account for these host behaviours:

- Lifecycle handlers are notifications after a change and cannot veto it.
- message.dispatch is the admission hook; thread creation itself is unhooked.
- Events missed while unloaded are not replayed; reconcile on startup.
- A waiting hook row can be reconsidered after an orphaned plugin wait is cleared.
- Thread plugin metadata is writable by other clients and is not an authorisation boundary.

Qualification pins the SDK/provider/host versions and records source/type evidence with the following probes:

| Gate | Experiment and required outcome | If it fails |
| --- | --- | --- |
| Q1a | Prepare thread while holding first message; crash before/after reference bind, race a fence and activation, drain queue/retry through the ordinary dispatch path. Count provider input admissions; at most one, only after committed permission. | Select another protected creation/provider mechanism; never weaken R06. |
| Q1b | With the Docket plugin enabled, finish a worker, reload the backend and restart bb, then unarchive and send/retry/steer through ordinary UI/agent/system dispatch. No further worker input may execute. Repeat with a crash while the first message waits on the plugin hook, then restore the enabled plugin and inspect admission before retry. | Revise plugin recovery and fencing before qualifying the bb launcher. Deliberate plugin disable, unload or replacement and explicit Send now are outside this gate. |
| Q1c | Lose SDK create/send response; inspect queue/timeline and replay command key. No second create/send without definite non-occurrence proof; uncertainty visible. | Keep unresolved effect; do not add blind retry. |
| Q2a | Place user/project settings, skills, context and extensions where provider would find them; verify actual loaded resources, cwd/model and allowed tools. With the provider's sandbox enabled, verify that a worker can edit, run fast checks and commit in its Treehouse worktree, which writes to the backing repository's `.git`, and can reach only the network its profile allows. Record which of these sandbox settings the plugin can set for a worker thread and which a person must configure. | Restrict supported provider/profile, or obtain approval for an explicit trust-model change. If a needed sandbox setting cannot be set by the plugin, document it and refuse to start a worker until it is configured, rather than letting the worker fail part-way. |
| Q2b | With the plugin enabled, inspect real interrupted/completed turns across backend reload and bb restart; compare provider events, thread state, queued inputs and result. Idle is never sufficient; terminal fence survives recovery. | Revise terminal mechanism before adapter acceptance. |
| Q2c | Archive/delete worker and parent/project, attempt environment removal and retries, with dirty output/active worker/preserved lease. Path/lease remains until core return is authorised; no premature teardown scripts. | Use externally attached retained paths as a qualified fallback, with explicit identity mapping and removal refusal. |

Tests may use synthetic providers/peers first. A real bb objective and standalone Pi dispatch are still required. Qualification evidence identifies the versions, environment, budget and observed results of each real experiment.
