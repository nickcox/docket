# bb launcher

The foreground Docket owner drives bb through argv-based CLI calls only. It does
not start a server or install the plugin. Configure a person-controlled `bb`
execution profile in `~/.config/docket/execution-profiles.json`, alongside the
existing `pi` and `checks` maps:

```json
{"bb":{"local":{"executable":"/absolute/path/to/bb","passEnvironment":[],"machineId":"host_LOCAL"}}}
```

Task profiles select `launcher: "bb"` and `executionProfile: "local"`, with an
explicit provider and model. The enabled Docket plugin must have a host-service
binding whose catalogue includes `host.bb-admit`.
Readiness refuses before thread creation if that check fails. Thread creation
uses the exact leased environment path. Before rechecking the held prompt, the
launcher verifies the thread, provider, project (when returned) and held queue
row's model. It verifies the path if bb has already attached an environment.
A successful recheck reply is not admission: the owner waits for the core's
activation claim. Lost or malformed effect replies are uncertain, never retried.

## Project set-up

A person must link the backing repository to a standard bb project on this
machine before dispatching. Docket never creates or changes bb projects:

```text
bb project create --name <name> --root <repository> --machine <machine>
bb project list --json
```

Use the context's backing repository, not a leased pool folder. Set `machineId`
in the person-controlled bb execution profile to this machine's exact bb host
ID. This explicit local-machine declaration prevents a source on another
machine with an identical filesystem path from being selected. No host-ID
file or bb database is read. The launcher matches `local_path` sources by that
ID and canonical filesystem path, counting each project once. Missing or
ambiguous matches are definite pre-create refusals with the set-up command as
the next action. A missing machine declaration also refuses before creation.

An optional `projectId` in that same execution profile overrides lookup. It is
passed literally as `--project`; the person must select a standard project with
a checkout on this machine. `machineId`, when supplied, is also passed as
`--machine`. Without it, an explicit project uses bb's local-machine resolution.
The personal project cannot accept the leased path environment.

Add this project ID to the Docket plugin's person-controlled `projects` setting
(a string of IDs separated by commas or whitespace, default empty):

```text
bb plugin config docket set projects <projectId>
bb docket ready <projectId>
```

Preserve any other project IDs already listed. The launcher finds the project
before calling readiness with that ID. Readiness refuses missing or unlisted
IDs, as well as binding failures, before any thread is created; its next action
names the `projects` setting.

## Workspace attachment and environment records (R34)

The launcher supplies `--environment <leased Treehouse path>`. bb attaches the
existing folder through its own checkout environment; it does not own, retire,
run set-up or teardown scripts in, or remove the folder. Docket alone controls
the lease and return. Archive/delete/cascade behaviour still needs pinned A56
qualification.

bb 0.49.0 leaves a held first prompt's thread pending with `environmentId: null`
and `environment: null`. It attaches the environment only when that prompt is
admitted. Neither the CLI nor the hook's environment intent exposes the requested
path beforehand. Docket therefore verifies the path at the first observation
after attachment, not before admission. A different attached path records a
bounded `environment_mismatch` worker observation and fences/stops the worker,
without retries. This extends the later-turn `result_discrepancy` refusal:
checks, acceptance, integration and return are blocked, even after candidate
selection. A person must inspect and discard the attempt; it is not resumed.

bb's environment record outlives the lease. When Treehouse recycles the folder,
an earlier worker's thread can stay attached and a later bb worker may reuse the
record. The hook refuses later turns on a finished worker, but a turn that
bypasses the hook could change a folder another attempt holds. Docket does not
remove bb environment records. Docket's recorded starting commit and output ref
remain authoritative, not bb's Git view of that record.

After core retention checks and stopping/fencing the worker, manually archive
the old worker thread (and any other threads holding the environment), then delete
the environment record. Use the environment ID from the thread, not a path guess:

```text
bb thread show <thread-id> --json
bb thread archive <thread-id> --json
bb environment delete <environment-id> --json
bb environment show <environment-id> --json
```

Deletion refuses while live threads hold the environment. Cleanup is asynchronous;
check `bb environment show` for destroyed/removed evidence. These commands never
delete the folder or run teardown scripts for this attached checkout. They do not
return a Treehouse lease or authorise recycling it.

## Definite refusals and uncertainty

Only a complete exit-1 JSON error envelope for `thread spawn` or `thread tell`
with `ok:false`, `error.code:"missing_required"` and a nonblank error message
is classified as a definite bb validation rejection. Its envelope is retained
as evidence. The inspected CLI raises this usage error before the external
create/send. A timeout, missing or unparseable output, generic `error`, and
`invalid_request` without command-specific proof remain uncertain. No call is
retried, including after a definite rejection under the same effect ID.

In particular, `ok:false` alone is **not** bb's promise of non-occurrence.
`chunk-WWZ7D6EQ.js` emits that shape for every caught CLI error;
`chunk-ZE7UK6GW.js` (`z`, `v`, `_`) wraps remote failures, including failures
after a request may have acted. `thread-MZN2MO7V.js` spawn action calls the
flag-only `$` helper (`u` in `chunk-U6DC65F7.js`), raises `missing_required`
before `threads.spawn`, and requires `--project`. The tell action resolves
its thread ID through `I` (`E` in `chunk-U6DC65F7.js`), which raises
`missing_required` before send. These are the only bb error codes treated as
definite by this adapter. Local readiness, directory and project-lookup
refusals are definite because no thread-create call has yet been made.

## Source evidence

Read-only inspection for this implementation used installed bb 0.49.0 and the
pinned SDK 0.6.132 declarations at
`/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/bb-admission-b538a77/source/bb/plugin/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.
Installed implementation paths below are relative to
`/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/`.

- SDK `MessageDispatchHookContext` and `threadQueuedMessageSchema` expose queue
  IDs and author categories, but no sender-chosen request ID. Inline dispatch
  exposes no queue row. Provider `clientRequestId` is not available to this hook.
- `server/dist/start-server.js`, `createQueuedThreadMessageInTransaction`
  (line 48843), generates the queue ID internally. `toThreadQueuedMessage`
  (73712) passes `initiator`, content and model; hook construction at 105262
  passes the claimed rows, not a sender-chosen ID. `recordQueuedMessageWait`
  (97384) records the exact input and execution model when the hook holds it.
- `host-daemon/dist/bb-chunks/thread-MZN2MO7V.js`, functions `j`, `J`, `Te`,
  `Wn` and `Ir`, constructs one text block from an inline prompt, without
  attachments or plan mode. Inline text is unchanged; file/stdin input strips
  trailing newlines. The launcher deliberately uses inline argv text, not files.
  `Wn` derives agent authorship from `BB_THREAD_ID`; the launcher's filtered
  environment excludes every `BB_` variable, giving ordinary CLI sends the
  author category `user`.
- SDK `threadResponseSchema` has no stopped status. CLI stop promises to stop
  work and release the loaded runtime. Terminal evidence here needs an ended
  turn, a confirmed stop reply, non-active thread state and the core fence
  effect. Idle alone is insufficient. Event sequences are durable thread-local
  sequences; usage uses only the cumulative `tokenUsage.total` fields that are
  actually reported, never fabricated zeros or cost.

The accepted plugin work already changed core correlation to exact content and
category `user`, rather than impossible command-ID/`docket` matching. This was
checked against the sources above and the real-SQLite grouped-message and
single-use admission tests. An identical copy can consume an authorised send
in its place: it cannot prove which sender's copy ran. Every grouped member
must match an unused recorded send before any are consumed. Unbound threads
hold only when a member matches a pending bb preparation's exact initial text
and user category; unrelated threads pass through.

## Limits and qualification

These are offline adapter and storage tests, not Q1/Q2 or A55 qualification.
No live provider, model or server was started for this work. bb workers load
the person's ordinary provider settings, skills, extensions, context and tools;
they are not sandboxed. Filtering the CLI's environment does not demonstrate
that an already running bb server strips its provider environment. That needs
live qualification for each supported combination.

The fence is best effort. Plugin disablement, unloading or replacement, Send
now, queue send, and unqualified recovery paths can bypass it. A worker thread
outside a project listed in the plugin's `projects` setting also bypasses the
hook without calling Docket, so Docket relies on later-turn detection. Docket reads
later turn starts as discrepancies and rechecks retained output before checks,
acceptance, integration and return. A later turn after lease return can still
change a workspace reused by another attempt; Docket cannot detect every such
change. Unknown owner state never authorises a retry or adoption.
