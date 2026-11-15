# Docket bb plugin – unqualified

This is separate from `bb/plugin`, the experimental synthetic probe. It provides
only dispatch admission and launcher control commands. It has no SQLite access, claims, event delivery, domain tools,
forms, status UI or supervisor registration. The core is called only through
`docket host invoke`. Everything must run on the same machine.

Offline-tested, not live-qualified. See [queue identity](#queue-identity) for
single-use content correlation and its identical-copy limit. These tests are not
Q1/Q2 qualification evidence.

## Installation and settings

Use bb 0.49.0 and SDK 0.6.132. Copy this folder to a retained scratch/build location
outside the repository, install its pinned development dependency there and run
`bb plugin types <copy> --check` and `bb plugin build <copy>`. Only after explicit
person approval, install with `bb plugin install <copy>`. Do not install or enable
it as part of offline tests. Keep all `node_modules` and `dist` output outside the
source checkout, as described in `bb/README.md`.

The person configures these plugin settings:

- `executable`: Docket executable on the server machine, default `docket`. No
  shell or arguments; use an absolute executable path where PATH is unsuitable.
- `binding`: absolute path to a private version 1 host-service binding, created
  by trusted Docket host set-up, limited to `host.bb-admit`.
  Never take it from thread metadata. Docket validates its
  permissions, identity and operation scope on every invocation. This setting is
  secret; the plugin does not read the binding itself or log command output.

Use `bb plugin config docket set <key> <value>` after installation. An ordinary
bb supervisor is unrestricted; use the Docket CLI for domain operations.

## Launcher commands

- `bb docket ready`: returns exit 0 with
  `{version:1,ready:true}` when the plugin is registered and
  its executable and binding settings are nonblank. A non-zero exit, missing
  command or invalid response must stop the launcher **before thread creation**.
  It probes `catalog.show` through the binding and requires `host.bb-admit`.
  Registration alone
  is not evidence of database availability, provider qualification or continued
  plugin presence.
- `bb docket recheck <threadId>`: requests re-evaluation, never sends a message.
  SDK 0.6.132 has only a global hook recheck; the response explicitly reports
  `scope:"all-plugin-held"`. Other held threads may also be reconsidered, each
  through a fresh core admission decision. bb paces/coalesces requests; success
  is not evidence of admission and a skipped request has no trailing retry.
  The launcher must observe admission and can make further explicit bounded
  recheck requests. Never use `thread queue send` to release held work.

The hook is registered before settings or CLI registration, on each normal
load/reload. It passes every queued member to the core. Unknown replies,
malformed envelopes, command failures and unsupported message blocks hold.
Before reference binding, the core holds messages matching a pending first
prompt's exact text and user author category. Unrelated threads pass through;
thread metadata never grants authority.

## Workspace attachment (R34)

The launcher passes `--environment <leased Treehouse path>`. bb attaches this
existing folder through its own checkout environment, without owning, retiring,
scripting or removing it. Only Docket controls the lease and its return.

bb's environment record outlives the lease. When Treehouse recycles the folder,
an earlier worker's thread can stay attached and a later bb worker may reuse the
record. The hook refuses later turns on a finished worker, but a turn that
bypasses the hook could change a folder another attempt holds. Docket does not
remove bb environment records. Docket's recorded starting commit and output ref,
not bb's Git view, are authoritative.

After core retention checks and stopping/fencing the worker, manually archive
the old worker thread (and any other threads holding the environment), then delete
the environment record. Obtain its ID from the thread, never guess from the path:

```text
bb thread show <thread-id> --json
bb thread archive <thread-id> --json
bb environment delete <environment-id> --json
bb environment show <environment-id> --json
```

Deletion refuses while live threads hold the environment. Cleanup is asynchronous;
check `bb environment show` for destroyed/removed evidence. These commands never
delete the folder or run teardown scripts for this attached checkout, and do not
return the Treehouse lease or authorise recycling it.

## Queue identity

Inspected SDK 0.6.132 `bundled-types/bb-plugin-sdk.d.ts`:
`MessageDispatchHookContext` and `threadQueuedMessageSchema`. Queue rows expose
`id`, `initiator`, `senderThreadId`, content and origin, but **no client request
ID**. Inline dispatch has an empty queued list and no request ID. The plugin
passes row `id`, author category `initiator` and exact text content per member,
not the first row's aggregate author. Inline sends expose no queue rows; the
plugin passes their input blocks and initiator as one member with a local
`inline` label. This label, like queue IDs, is not used for correlation.

Installed bb 0.49.0 `server/dist/start-server.js` confirms:

- `createQueuedThreadMessageInTransaction` calls `createQueuedThreadMessageId()`
  internally; callers cannot choose it.
- The hook-pass construction passes `claimed?.map(toThreadQueuedMessage) ?? []` into
  the hook; it does not pass a sender-selected client request ID.
- CLI `thread-MZN2MO7V.js` queue create accepts message/model/attachments, not an
  ID. CLI messages without a sender have author category `user`, not `docket`.

Core `admitBbDispatch` matches exact content with author category `user` against
single-use recorded sends on the bound thread: stored `worker.prepare.initialInput`
through the one activation admission, then claimed `worker.deliver.message`
effects. The launcher must run CLI sends without `BB_THREAD_ID`, which would
attribute them to an agent instead. No IDs or markers are inserted into text.
An identical copy arriving first is admitted in place of the recorded send; the
worker still receives that text once per authorised send. This cannot prove which
sender's copy ran. Two identical recorded sends can each admit one member. Every
group member must match before anything is consumed; replays refuse. Correlation
is localised in the core so a future sender-chosen host ID can replace it.
Offline tests exercise this with real temporary SQLite and fake boundaries,
**not successful real queue admission**.

## R33 limits

The hook is a best-effort guard only while this plugin is installed, enabled and
on the ordinary dispatch path. Disable, unload, replacement, Send now,
`bb thread queue send` and unqualified host recovery can bypass it. Reload and
restart re-register the hook, but offline tests do not qualify recovery races.
The launcher/core must still detect later turns and recheck candidate commit,
result and workspace before checks, acceptance, integration and return. Idle or
stopped alone is not terminal evidence. A later turn after lease return could
modify another attempt's reused workspace; Docket cannot detect every such
change. Stale owner claims require person resolution, never adoption/restart.

bb workers have the person's ordinary provider resources, user/project settings,
skills, extensions, context sources and tools. This plugin does not sandbox or
strip them. The launcher must verify cwd, provider, model and profile credential
selection before activation. Real Q1/Q2/A55/A56 qualification is not established
by these offline tests.

## Offline checks

From the repository root: `npm run check`,
`node --test tests/bb-docket-plugin.test.ts` and `npm test`. These use fake SDK
registrations and a fake Docket command, with no installed bb or SDK dependency.
The separate `server.ts` entry should also be typechecked in the scratch copy
against the pinned real SDK before build/install.
