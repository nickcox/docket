# CLI operations

`node bin/docket.ts catalog show --json` is the source of operation names, required JSON fields, roles and schemas. All input fields are required, including nullable fields and `dryRun` on planable operations. Unknown fields refuse. The ordinary CLI derives the person identity from the OS user; JSON cannot supply a caller or an approval role.

Use `--config /absolute/context.json` or a registered `--context name`, and exactly one of `--stdin` and `--input file.json`. Every command writes one version-1 envelope to stdout. Dispatch progress goes to stderr. Person mutations generate a request ID unless `--request-id key` is supplied. Reuse that key after a lost response, with the same input. Task mutations and their replay result commit together.

## Tasks

For example, add a task:

```sh
printf '%s' '{"id":"notes","definition":{"title":"Write notes","instructions":"Write and commit the notes.","criteria":["The notes explain the change"],"kind":"code","profile":null},"objectiveId":null}' |
  node bin/docket.ts task add --context example --stdin --json
```

`task.show`, `task.list` and `status.show` expose readiness and holds. `task.update` replaces the definition at `expectedRevision`. Holds, releases, dependencies, reorder and explicit done/reopen judgements use separate operations. Marking a task done does not invent accepted evidence. Reorder names every task in this context exactly once.

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

Plan dispatch with `{"taskId":"notes","profile":null,"dryRun":true}`. Change only `dryRun` to false to execute. Dispatch reserves, acquires, starts, prepares, binds, permits and activates one worker, waits for its turn, fences it and observes direct-child exit, validates its result, records completion and runs the trusted checks. It does not accept output or return the lease. A replay inspects progress and never launches another worker.

## Acceptance and return

Plan acceptance with `{"attemptId":"<UUID>","candidateCommit":null,"overrideReason":null,"dryRun":true}`. The ordered steps include missing checks and conditional acceptance. Execution rechecks the evidence and policy before effects. `local-merge` fast-forwards the configured target; manual acceptance retains the branch without claiming integration. An explicit candidate commit is checked and planned before selection. A person's nonblank override reason can waive checks, but never identity, retention or terminal evidence.

Only a person can return or discard. `attempt.return` requires `noProcesses:true` for the exact attempt's immutable lease. `attempt.discard` also requires `confirmDiscard:true` and a reason. A terminal attempt with no recorded outcome can be discarded without a result file: the discard authorisation atomically records `failed`. The workspace must still be clean and match its allocation, and no effect may be unresolved. Running workers cannot be discarded.

## Resolving uncertainty

`claim.resolve` names the exact claim UUID; `effect.resolve` names the exact effect UUID and `happened` or `not_happened`. Both require person authority, nonblank scoped evidence and `confirmStopped:true`. A stale heartbeat is diagnostic only and never resolves anything. Specialised owner reads must not contradict the person's resolution. Resolving an effect does not silently take over its owner claim, relaunch a worker, acquire another workspace or retry the effect. Inspect the remaining status and resolve each exact scope separately.

Dry runs open the database read-only. They do not create claims, refresh heartbeats, authorise effects or record events. Plans are observations, not lasting permission.
