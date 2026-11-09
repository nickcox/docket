# CLI operations

`node bin/docket.ts catalog show --json` is the source of operation names, required JSON fields, roles and schemas. All input fields are required, including nullable fields and `dryRun` on planable operations. Unknown fields refuse. The ordinary CLI derives the person identity from the OS user; JSON cannot supply a caller or an approval role.

Use `--config /absolute/context.json` or a registered `--context name`, and exactly one of `--stdin` and `--input file.json`. Every command writes one version-1 envelope to stdout. Dispatch progress goes to stderr. Person mutations generate a request ID unless `--request-id key` is supplied. Reuse that key after a lost response, with the same input. Task mutations and their replay result commit together.

## Configuration

Edit the person-controlled configuration file, then run `context.configure` with `{"dryRun":true}` to report changed top-level fields and the next revision. Run it with `{"dryRun":false}` to apply the file. Both use the strict configuration parser and require quiescence: no execution-open attempt, unreleased claim, or claimed or uncertain effect. Refusals list every blocking item; resolve each before trying again.

`contextId`, `databasePath`, `stateDirectory`, `repository` and `workspace` cannot change. Configuration changes are person-only. A changed digest records one new `context.configured` event with the resolved configuration and source file; later operations accept that digest and revision, not the previous file. An equivalent file records no event. Dry runs change nothing.

## Tasks

For example, add a task:

```sh
printf '%s' '{"id":"notes","definition":{"title":"Write notes","instructions":"Write and commit the notes.","criteria":["The notes explain the change"],"kind":"code","profile":null},"objectiveId":null}' |
  node bin/docket.ts task add --context example --stdin --json
```

`task.show`, `task.list` and `status.show` expose readiness and holds. `task.update` replaces the definition at `expectedRevision`. Holds, releases, dependencies, reorder and explicit done/reopen judgements use separate operations. Marking a task done does not invent accepted evidence. Reorder names every task in this context exactly once.

Use `task.block` with `{"taskId":"notes","blockerId":"prerequisite"}` to add a dependency; `task.unblock` takes the same fields to remove it. Neither operation accepts `dryRun`. A self-dependency, missing task, duplicate edge or cycle refuses without changes. Reusing the original request ID replays the original result instead of adding the edge again. Removing an absent edge changes nothing.

Each dependency change records the actor, before/after task and incremented `decisionRevision`; it leaves `definitionRevision` unchanged. `task.show` and `status.show` expose `blockedBy`. A queued, unheld task is ready only when all its blockers are done. `task.list` with `readyOnly:true` and automatic dispatch use that same rule. Completing or reopening a blocker changes future readiness; it does not change an already started or finished dependant's state.

Lists use `page:{"after":null,"limit":100}` initially and return the next cursor. Status uses a shared cursor across its task, attempt, claim and effect sections; its `page` gives the overall count and next cursor.

## Objectives

`objective.add` takes `id`, `request`, ordered `criteria`, `scope`, `constraints`, `permissions`, `budget` and `deadline`. It creates an open objective owned by the calling OS user. `permissions:null` enables every R18 permission; a permission object can omit fields, which default to true. Unknown fields and non-boolean values refuse.

`budget:null` selects unlimited usage: `{"maxCost":null,"currency":null,"maxTokens":null,"maxWorkerTimeMs":null}`. A budget object must contain exactly those four fields. Limits are nonnegative, tokens and worker time are integers, and a finite cost requires a nonblank currency. Unlimited cost can retain a reporting currency. `deadline` is null or an ISO timestamp with an explicit offset, such as `2026-12-01T17:00:00+11:00`.

Budgets and deadlines are validated and stored as supplied, but **are not yet enforced**, including at dispatch. Objective completion (statements and evidence matching), usage accounting and supervisors remain later work. Permissions are stored for supervisor authority; they do not restrict a person's task operations.

`objective.show` takes `objectiveId` and returns the current definition, revision, state and closure. `objective.update` takes `objectiveId`, `expectedRevision`, `criteria`, `scope`, `constraints`, `permissions`, `budget` and `deadline`. It replaces these fields; only the creator can change criteria, permissions, budget or deadline. Another person can change scope and constraints without changing protected fields. Supervisors cannot use this operation.

`objective.abandon` takes `objectiveId` and a nonblank `reason`, and is creator-only. `objective.reopen` takes the same fields, clears the current closure and statements, and retains the prior values in objective events. A scoped supervisor reopening an objective requires `manageTasks`. Neither operation stops workers, accepts output or returns leases.

Link a task when adding it by supplying `objectiveId`. `task.move` takes `taskId`, `expectedRevision` (the task's definition revision) and `objectiveId`, with null unlinking the task. It is person-only and increments the definition revision when membership changes. Both the source and destination objectives must be open before changing membership. `task.update` cannot change membership. Objective-linked tasks can be dispatched; attempts retain the objective they started under even if their task later moves.

These objective operations and `task.move` use command replay records. Their contracts do not take `dryRun`; dispatch remains planable with the same linked-task prerequisites in planning and execution.

## Standalone Pi dispatch

The CLI currently uses the standalone Pi launcher and real Treehouse workspaces. bb qualification and host transport are separate work; a bb profile refuses before reservation.

Create a person-controlled `~/.config/docket/execution-profiles.json`, not writable by group or others. It is host configuration, never task input. Example:

```json
{
  "version": 1,
  "pi": {
    "pi-worker-v1": {
      "executable": "/absolute/path/to/node",
      "sdkModule": "/absolute/path/to/pi/dist/index.js",
      "agentFiles": {"auth":"/absolute/path/to/.pi/agent/auth.json"},
      "passEnvironment": []
    }
  },
  "checks": {
    "node-project-v1": {
      "id":"node-project-v1",
      "tools":{"node":"26.7.0"},
      "dependencies":{"lock":"record-the-approved-dependency-digest"},
      "ignoredGeneratedPaths": []
    }
  }
}
```

The context worker profile selects `launcher:"pi"` and `executionProfile:"pi-worker-v1"`. Its check configuration selects the check profile ID. For an approved RPC executable, use `executable` with an optional absolute `entrypoint` instead of `sdkModule` and `agentFiles`. Credential references belong only in these host settings, not task records.

Request a stop with `attempt.stop`: `{"attemptId":"<UUID>","dryRun":false}`. Use `dryRun:true` to plan without recording a request. The command records the request; it does not claim that the worker has stopped. The owning dispatch checks recorded requests before launch admission and on each worker-wait poll (normally every 50 milliseconds). A request before launch permission fences admission. The owner records and claims a launcher fence effect once, then records `interrupted` only after a fresh launcher read proves terminal state. Work and its lease stay retained for inspection. A missing or uncertain owner leaves the request recorded; it never grants another process ownership. Reusing the same request ID and input does not repeat the effect.

`attempt.steer` requires `{"attemptId":"<UUID>","message":"Change direction","mode":"active","dryRun":false}`; mode is `active` or `after_turn`. Capability checks also apply to dry runs. Pi supports neither mode, so both refuse with `capability_missing`, without recording a delivery effect or sending a message. Supported launchers receive recorded requests through the owning dispatch, with one claimed delivery effect and no retry after uncertainty.

A failed model turn is fenced and settled immediately without a result file. Dispatch refuses with `worker_failed`, naming the attempt, profile, failure kind (`provider_limit` or `model_error`) and bounded, redacted message. Clean leases return automatically; unsafe returns stay held. Broken launcher connections remain `owner_unknown`.

A `provider_limit` failure limits the profile until a person runs `profile clear` with `{"profile":"worker","dryRun":false}` after the provider limit resets. Use `dryRun:true` to plan without changing the limit. Named and default dispatch refuse with `provider_limited` before reservation; automatic dispatch skips and reports tasks using limited profiles. Status lists limited profiles with their failure time, message and next action. Provider-limit attempts do not count towards the per-task attempt limit.

Plan dispatch with `{"taskId":"notes","profile":null,"dryRun":true}`. Change only `dryRun` to false to execute. Dispatch reserves, acquires, starts, prepares, binds, permits and activates one worker, waits for its turn, fences it and observes direct-child exit, validates its result, records completion and runs the trusted checks. It does not accept output. After recording a held or failed outcome, or any review outcome, it checks whether the lease can be returned automatically. A replay inspects progress and never launches another worker.

## Continuation

A person can plan `attempt.continue` with `{"sourceAttemptId":"<UUID>","sourceCommit":null,"profile":null,"note":null,"dryRun":true}`. The source identifies the task. Release any task hold first. The plan reports `startingCommit` and its subject. Execute with `dryRun:false`; the new attempt uses the source output ref's commit at reservation, even without a source candidate. A person may instead supply an exact `sourceCommit` between the source's starting commit and its current output head, inclusive.

The source must be terminal and settled, with a retained output ref and no unresolved effect. Its held workspace must be clean, including untracked files, or continuation refuses with `workspace_dirty`. Other workers and leases for the task block continuation; only the source's held lease is exempt. Readiness, attempt limits, capacity and profile limits still apply. Continuing neither accepts the source's work nor prompts its worker again.

The new attempt has its own output ref, lease and session. Its immutable handover includes source identity, candidate, outcome and failure, criteria, recorded checks and your note. It also includes recorded review findings; question history remains empty until question operations are implemented. The worker must verify inherited work against the task. A private ref pins the recorded start before workspace acquisition; conditional cleanup preserves a moved ref and records uncertain cleanup for resolution. Source lease return follows the ordinary safe-return rules. Reuse the same request ID and input after a lost response: replay returns the original attempt without allocation or activation.

## Independent review

Plan `attempt.review` with `{"attemptId":"<source UUID>","dryRun":true}`, then execute with `dryRun:false`. It creates a separate task of kind `review`, without accepting the source or reopening its launch. The source needs a stopped, terminal, settled worker, an exact retained Git candidate and no unresolved effects. `task.add` cannot create review tasks; `task.update` cannot change their copied criteria, target instructions or kind. A different target needs a new review task.

Dispatch the returned task ID normally. `profileByKind.review` selects its default profile. The workspace starts exactly at the captured candidate commit, with a separate lease, output branch and session. The immutable `reviewTarget` contains `sourceAttemptId`, `candidateId`, `commit`, `outputRef`, `repository`, copied `criteria` and recorded `checkResults`. The reviewer inspects those check results and runs focused tests rather than the full suite again. Reviewers must not commit changes, and Docket does not run full checks for a review result.

A completed review reports every criterion and includes exactly one work reference of shape `{"kind":"reviewed-output","name":"review","target":<the exact reviewTarget object>}`. Retained artefact references are also allowed. Every criterion met records `passed`; any not met records `failed`. The verdict, attempt outcome and review task completion commit together. Missing, malformed, interrupted or wrong-target results give no verdict. Replay does not duplicate findings. If the source candidate changes before completion, the review result remains readable but records no verdict for that replacement. After recording a completed, held or failed review outcome, Docket automatically returns the lease when the ordinary safe-return checks pass, whether or not it recorded a verdict. Uncommitted or untracked review work keeps the lease; `status.show` gives the reason and a next action.

`attempt.show` and each `status.show` attempt include `review`: `current` is the latest matching `review.recorded` event (or null), `findings` retains earlier events, and `tasks` lists linked review tasks. Current evidence matches the candidate and the source task's current criteria. A new commit needs a new review. Person acceptance does not require a review; supervisor acceptance will require a passing review when supervisors are implemented.

## Acceptance and return

If acceptance needs checks but their slot is occupied, it refuses with `checks_waiting`, not `check_failed`. Data includes `checkRequest` (its internal `id`, public `requestId`, state and evidence key) and `slotHolders` (claim, attempt, check request and owner identities). A claimed run also reports `checks_waiting` with its actual state. Follow `nextAction` to retry acceptance after the slot is free; the pending checks then run and acceptance continues if they pass. `check_failed` means a recorded result failed; missing checks report `check_missing` and uncertain checks report `effect_uncertain` with the request to inspect.

Run checks for a recorded candidate of a terminal attempt with `checks.run`: `{"attemptId":"<UUID>","commit":"<commit>","dryRun":false}`. Use `dryRun:true` to plan without writes or commands. Docket runs fast checks then full checks in the attempt's workspace and records exact-commit evidence. A matching pass is reused. Replaying the same request ID never reruns a finished check request, including a failure; use a new `--request-id` for an explicit retry after failure. An occupied full-check slot reports `checks_waiting` with its holders; retry the same pending request when the slot is free. Uncertain runs must be resolved before their slot can be reused. This operation does not select a candidate or accept output.

Plan acceptance with `{"attemptId":"<UUID>","candidateCommit":null,"overrideReason":null,"dryRun":true}`. The ordered steps include missing checks and conditional acceptance. Execution rechecks the evidence and policy before effects. `local-merge` fast-forwards the configured target; manual acceptance retains the branch without claiming integration. An explicit candidate commit is checked and planned before selection. A person's nonblank override reason can waive checks, but never identity, retention or terminal evidence.

After acceptance (manual or `local-merge`), discard, a dispatch with a held or failed outcome, or a completed review dispatch, Docket checks whether no work could be lost and returns the lease automatically when safe. The response's `leaseReturn` gives `state:"returned"` or `state:"kept"` and a reason. Automatic returns use the recorded return effect and conditional output-ref clean-up; manually accepted branches remain retained.

A person can explicitly request the same checks with `attempt.return`: `{"attemptId":"<UUID>","dryRun":false}`. Only a person can discard, using `attempt.discard` with `confirmDiscard:true` and a nonblank `reason`. Neither operation accepts `noProcesses`. A terminal attempt with no recorded outcome can be discarded without a result file: the discard authorisation atomically records `failed`. The worker must be stopped and terminal, the workspace must be clean and match its allocation and pool, no effect may be unresolved, and required output must be retained unless discarded. Running workers cannot be discarded. Docket does not try to prove that every process the worker started has stopped.

When return is unsafe the lease is kept. `status.show` with `attentionOnly:true` lists the attempt's current return condition and a next action. Preserve or commit uncommitted and untracked work, retain output, or resolve uncertain effects before requesting a return.

## Request inspection

Use `request.show` with `{"requestId":"<public replay key>"}` to follow a refusal's next action or inspect a command's progress. This is the printed replay key, not the internal request UUID. The read returns the internal ID and public key, operation, state, caller, linked attempt and objective, parent command identity, typed target, immutable input and recorded result. A command also lists up to 20 linked effects with their states and the total count; inspect an effect by its own public key for detail. Unknown keys refuse with `invalid_input`.

The read changes nothing and is not planable, so it has no `dryRun` field. A person can inspect every request. The storage read keeps objective scope explicit for later supervisor bindings; unscoped context commands remain person-only. Credentials and environment fields are redacted recursively, including diagnostic credential patterns. Large input and result objects become marked, bounded summaries (128 KiB and 32 KiB respectively); stored inputs and results are not changed.

## Diagnostic retention

A person can plan `diagnostics.clean` with `{"attemptId":"<UUID>","noProcesses":true,"dryRun":true}` and execute with `dryRun:false`. `noProcesses:true` is the person's confirmation that no processes depend on the diagnostics; it is not a launcher observation. The attempt must also be terminal and settled, its lease returned, its worker claims released and its other effects resolved.

Only `attempts/<attemptId>/diagnostics/` beneath the state directory is eligible. Results, required artefacts and retained output must stay outside it. Linked or non-regular files, changed contents and references from authoritative evidence refuse deletion. The immutable deletion intent lists every file's relative path, size and SHA-256 digest, and every directory. The effect result records this manifest and the completion time. Interrupted deletion resumes only that manifest; new or changed files are never removed. Reuse the original request ID and input to resume. No task, attempt, request mapping, claim, result or evidence row is deleted, and old dispatch replay still returns recorded progress without launching work.

## Resolving uncertainty

`claim.resolve` names the exact claim UUID; `effect.resolve` names the exact effect UUID and `happened` or `not_happened`. Both require person authority, nonblank scoped evidence and `confirmStopped:true`. A stale heartbeat is diagnostic only and never resolves anything. Specialised owner reads must not contradict the person's resolution. Resolving an effect does not silently take over its owner claim, relaunch a worker, acquire another workspace or retry the effect. Inspect the remaining status and resolve each exact scope separately.

Dry runs open the database read-only. They do not create claims, refresh heartbeats, authorise effects or record events. Plans are observations, not lasting permission.
