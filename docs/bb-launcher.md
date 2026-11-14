# bb launcher

The foreground Docket owner drives bb through argv-based CLI calls only. It does
not start a server or install the plugin. Configure a person-controlled `bb`
execution profile in `~/.config/docket/execution-profiles.json`, alongside the
existing `pi` and `checks` maps:

```json
{"bb":{"local":{"executable":"/absolute/path/to/bb","passEnvironment":[]}}}
```

Task profiles select `launcher: "bb"` and `executionProfile: "local"`, with an
explicit provider and model. The enabled Docket plugin must have a host-service
binding whose catalogue includes `host.bb-admit` and `host.bb-allocation`.
Readiness refuses before thread creation if that check fails. Thread creation
uses the exact leased environment path. Before rechecking the held prompt, the
launcher verifies that path and provider, and the held queue row's model.
A successful recheck reply is not admission: the owner waits for the core's
activation claim. Lost or malformed effect replies are uncertain, never retried.

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
now, queue send, and unqualified recovery paths can bypass it. Docket reads
later turn starts as discrepancies and rechecks retained output before checks,
acceptance, integration and return. A later turn after lease return can still
change a workspace reused by another attempt; Docket cannot detect every such
change. Unknown owner state never authorises a retry or adoption.
