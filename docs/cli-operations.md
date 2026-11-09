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

A failed model turn is fenced and settled immediately without a result file. Dispatch refuses with `worker_failed`, naming the attempt, profile, failure kind (`provider_limit` or `model_error`) and bounded, redacted message. Clean leases return automatically; unsafe returns stay held. Broken launcher connections remain `owner_unknown`.

A `provider_limit` failure limits the profile until a person runs `profile clear` with `{"profile":"worker","dryRun":false}` after the provider limit resets. Use `dryRun:true` to plan without changing the limit. Named and default dispatch refuse with `provider_limited` before reservation; automatic dispatch skips and reports tasks using limited profiles. Status lists limited profiles with their failure time, message and next action. Provider-limit attempts do not count towards the per-task attempt limit.

Plan dispatch with `{"taskId":"notes","profile":null,"dryRun":true}`. Change only `dryRun` to false to execute. Dispatch reserves, acquires, starts, prepares, binds, permits and activates one worker, waits for its turn, fences it and observes direct-child exit, validates its result, records completion and runs the trusted checks. It does not accept output. After recording a held or failed outcome it checks whether the lease can be returned automatically. A replay inspects progress and never launches another worker.

## Continuation

A person can plan `attempt.continue` with `{"sourceAttemptId":"<UUID>","sourceCommit":null,"profile":null,"note":null,"dryRun":true}`. The source identifies the task. Release any task hold first. The plan reports `startingCommit` and its subject. Execute with `dryRun:false`; the new attempt uses the source output ref's commit at reservation, even without a source candidate. A person may instead supply an exact `sourceCommit` between the source's starting commit and its current output head, inclusive.

The source must be terminal and settled, with a retained output ref and no unresolved effect. Its held workspace must be clean, including untracked files, or continuation refuses with `workspace_dirty`. Other workers and leases for the task block continuation; only the source's held lease is exempt. Readiness, attempt limits, capacity and profile limits still apply. Continuing neither accepts the source's work nor prompts its worker again.

The new attempt has its own output ref, lease and session. Its immutable handover includes source identity, candidate, outcome and failure, criteria, recorded checks and your note. Review findings and questions remain empty until those operations are implemented. The worker must verify inherited work against the task. A private ref pins the recorded start before workspace acquisition; conditional cleanup preserves a moved ref and records uncertain cleanup for resolution. Source lease return follows the ordinary safe-return rules. Reuse the same request ID and input after a lost response: replay returns the original attempt without allocation or activation.

## Acceptance and return

If acceptance needs checks but their slot is occupied, it refuses with `checks_waiting`, not `check_failed`. Data includes `checkRequest` (its internal `id`, public `requestId`, state and evidence key) and `slotHolders` (claim, attempt, check request and owner identities). A claimed run also reports `checks_waiting` with its actual state. Follow `nextAction` to retry acceptance after the slot is free; the pending checks then run and acceptance continues if they pass. `check_failed` means a recorded result failed; missing checks report `check_missing` and uncertain checks report `effect_uncertain` with the request to inspect.

Run checks for a recorded candidate of a terminal attempt with `checks.run`: `{"attemptId":"<UUID>","commit":"<commit>","dryRun":false}`. Use `dryRun:true` to plan without writes or commands. Docket runs fast checks then full checks in the attempt's workspace and records exact-commit evidence. A matching pass is reused. Replaying the same request ID never reruns a finished check request, including a failure; use a new `--request-id` for an explicit retry after failure. An occupied full-check slot reports `checks_waiting` with its holders; retry the same pending request when the slot is free. Uncertain runs must be resolved before their slot can be reused. This operation does not select a candidate or accept output.

Plan acceptance with `{"attemptId":"<UUID>","candidateCommit":null,"overrideReason":null,"dryRun":true}`. The ordered steps include missing checks and conditional acceptance. Execution rechecks the evidence and policy before effects. `local-merge` fast-forwards the configured target; manual acceptance retains the branch without claiming integration. An explicit candidate commit is checked and planned before selection. A person's nonblank override reason can waive checks, but never identity, retention or terminal evidence.

After acceptance (manual or `local-merge`), discard, or a dispatch with a held or failed outcome, Docket checks whether no work could be lost and returns the lease automatically when safe. The response's `leaseReturn` gives `state:"returned"` or `state:"kept"` and a reason. Automatic returns use the recorded return effect and conditional output-ref clean-up; manually accepted branches remain retained.

A person can explicitly request the same checks with `attempt.return`: `{"attemptId":"<UUID>","dryRun":false}`. Only a person can discard, using `attempt.discard` with `confirmDiscard:true` and a nonblank `reason`. Neither operation accepts `noProcesses`. A terminal attempt with no recorded outcome can be discarded without a result file: the discard authorisation atomically records `failed`. The worker must be stopped and terminal, the workspace must be clean and match its allocation and pool, no effect may be unresolved, and required output must be retained unless discarded. Running workers cannot be discarded. Docket does not try to prove that every process the worker started has stopped.

When return is unsafe the lease is kept. `status.show` with `attentionOnly:true` lists the attempt's current return condition and a next action. Preserve or commit uncommitted and untracked work, retain output, or resolve uncertain effects before requesting a return.

## Resolving uncertainty

`claim.resolve` names the exact claim UUID; `effect.resolve` names the exact effect UUID and `happened` or `not_happened`. Both require person authority, nonblank scoped evidence and `confirmStopped:true`. A stale heartbeat is diagnostic only and never resolves anything. Specialised owner reads must not contradict the person's resolution. Resolving an effect does not silently take over its owner claim, relaunch a worker, acquire another workspace or retry the effect. Inspect the remaining status and resolve each exact scope separately.

Dry runs open the database read-only. They do not create claims, refresh heartbeats, authorise effects or record events. Plans are observations, not lasting permission.
