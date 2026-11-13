# Docket bb plugin – unqualified

This is separate from `bb/plugin`, the experimental synthetic probe. It provides
only dispatch admission, a recorded-allocation environment provider and launcher
control commands. It has no SQLite access, claims, event delivery, domain tools,
forms, status UI or supervisor registration. The core is called only through
`docket host invoke`. Everything must run on the same machine.

**Not ready for worker activation:** the pinned host's queue identity contract
cannot currently match Docket's recorded delivery identifiers. See
[queue identity](#queue-identity). Do not use this plugin as qualification evidence
or create real workers with it until that contract is resolved.

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
  by trusted Docket host set-up, limited to `host.bb-admit` and
  `host.bb-allocation`. Never take it from thread metadata. Docket validates its
  permissions, identity and operation scope on every invocation. This setting is
  secret; the plugin does not read the binding itself or log command output.

Use `bb plugin config docket set <key> <value>` after installation. An ordinary
bb supervisor is unrestricted; use the Docket CLI for domain operations.

## Launcher commands

- `bb docket ready`: currently returns exit 1 with
  `{version:1,ready:false,providerId:"docket",reason:"queue_identity_unresolved"}`
  after checking settings. This deliberately blocks thread creation until the
  queue identity contract is resolved. A non-zero exit, missing command or invalid
  response must stop the launcher **before thread creation**. Registration alone
  is not evidence of database availability, provider qualification or continued
  plugin presence.
- `bb docket recheck <threadId>`: requests re-evaluation, never sends a message.
  SDK 0.6.132 has only a global hook recheck; the response explicitly reports
  `scope:"all-plugin-held"`. Other held threads may also be reconsidered, each
  through a fresh core admission decision. bb paces/coalesces requests; success
  is not evidence of admission and a skipped request has no trailing retry.
  The launcher must observe admission and can make further explicit bounded
  recheck requests. Never use `thread queue send` to release held work.

The hook is registered before settings, environment or CLI registration, on each
normal load/reload. It passes every queued member to the core. Unknown replies,
malformed envelopes, command failures and unsupported message blocks hold. A
Docket provider intent before reference binding holds even when the core cannot
locate that thread. Metadata and intent can locate or block, never grant authority.

## Environment provider (R34)

Select provider `docket` with inputs `{ "leaseId": "<recorded lease>" }` through
the CLI/SDK; no frontend inputs control is supplied. Create calls
`host.bb-allocation` and returns only its absolute recorded path, with
`ownsPath:false`. Repeated calls reverify the same lease. No acquisition,
directory creation/removal, setup, teardown or Git mutation occurs here.
`retireGraceMs:null` disables automatic retirement; the pinned SDK documents that
`ownsPath:false` also suppresses both host environment scripts. Remove always
refuses with a Docket return hint, including archive/delete/cascade retries.
Only the core can authorise workspace return. No restore or existing-path shortcut
bypasses allocation verification. The command transport uses private temporary
JSON input files and removes those, never workspace paths.

The allocation operation currently returns only `path`, so this plugin cannot
supply a verified starting merge base or identity resource to bb's Git view.
Do not interpret bb's default base as exact attempt evidence; use the recorded
Docket specification and starting commit. This remains a qualification limit.

## Queue identity

Inspected SDK 0.6.132 `bundled-types/bb-plugin-sdk.d.ts`:
`MessageDispatchHookContext` and `threadQueuedMessageSchema`. Queue rows expose
`id`, `initiator`, `senderThreadId`, content and origin, but **no client request
ID**. Inline dispatch has an empty queued list and no request ID. The plugin
currently passes row `id`, author `initiator` (or `initiator:senderThreadId` for
agent senders) and text content, not the first row's aggregate author.

Installed bb 0.49.0 `server/dist/start-server.js` confirms:

- `createQueuedThreadMessageInTransaction` calls `createQueuedThreadMessageId()`
  internally; callers cannot choose it.
- The hook-pass construction passes `claimed?.map(toThreadQueuedMessage) ?? []` into
  the hook; it does not pass a sender-selected client request ID.
- CLI `thread-MZN2MO7V.js` queue create accepts message/model/attachments, not an
  ID. CLI messages without a sender have author category `user`, not `docket`.

Core `admitBbDispatch` currently matches `initialMessageId/initialAuthor`, and
later `worker.deliver` intents record command ID/author `docket`. Those values
cannot match these real rows. No unsafe content-only identity fallback is used.
A question is pending about a sender-chosen text envelope versus an upstream bb
contract change. The present offline tests cover transport and fail-closed
mapping, **not successful real queue admission**.

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
