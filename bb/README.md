# Experimental bb harness – unqualified

Experimental work, not a production Docket launcher. Startup fixes through `194b442dbde7ff718ac70e45beaaa815e09fc278` are integrated. The synthetic admission entry has been repaired offline; its live Q1a/Q1b results are **pending supervisor execution**, not passing qualification. Q1c, Q2, real Pi/model/resource qualification and actual Docket authority/provenance remain unproven. No old retained code was restored in this attempt.

## Startup repair (R31, R33)

The macOS live harness requires plain Node 26.7.0, installed bb 0.49.0 at `/Applications/bb.app`, and plugin SDK 0.6.132. It never launches Electron. It creates a private temporary home/data directory and two non-default loopback ports. No normal bb configuration or Keychain changes are needed or permitted.

Startup now:

1. Starts the separate server, with no daemon connected.
2. Reads the public provider catalogue, whose handler waits for initial registration. That wait can time out inside bb, so the harness also polls the plugin inventory: all four pinned builtin provider plugins must be present, enabled ones must be running and represented in the catalogue, and no plugin may still be `starting`.
3. Installs the experimental `docket-probe` plugin, awaiting installation completion. Its provider is `docket-synthetic`.
4. Disables `provider-claude-code`, `provider-codex` and `provider-acp` using public plugin disable operations. Checks each response, then independently rereads both inventories. Only `provider-pi` (`pi`) and `docket-probe` (`docket-synthetic`) may contribute enabled providers. Missing Pi, malformed/failed reads, failed disables, incomplete registration or an unexpected enabled provider refuse enrollment/connection.
5. Only then mints the isolated host enrollment key and starts the daemon.

`provider-retry` and `bb--provider-usage` are not agent provider plugins and are not changed. Unknown `provider-*` plugins (apart from `provider-retry`) and any unexpected plugin with registered provider IDs are refused, not silently trusted.

For a controlled server restart, the daemon and its observed descendants are stopped **before** restarting the server. The same private data persists. Registration and provider selection are checked again before daemon reconnection; lost selection is refused rather than silently repaired. This is restart plumbing, not live evidence that the Q1 experiments pass.

The harness routes every plugin CLI/API operation to its explicit isolated URL and private data/home. Plugin selection uses the public HTTP operations, not database edits or installed-code patches.

All harness control HTTP requests, including version readiness, send `Connection: close`. Synchronous CLI installation blocks the client's event loop while the separate server can close idle sockets; pooled fetch can then reuse a stale socket and fail with `ECONNRESET`. The shared transport does not retry mutations. Fetch/body-read failures include method and path and retain the original cause, without including the request body or credentials.

### Installed contract evidence

Inspected the installed code, without executing a live server or provider:

- `bb-app/host-daemon/dist/bb-chunks/plugin-K4RLPVUQ.js`, `registerPluginCommands`: `plugin list --json` returns **`{ plugins: [...] }`**, not an array. `plugin disable <id> --json` returns `{ ok, plugin }`. Installation waits unless `--no-wait` is supplied.
- `bb-app/dist/index.js`, installed-plugin and runtime-status schemas: inventory rows have `id`, `enabled`, `status`, `providerIds`; `starting` is not ready. SDK `plugins.list()` preserves the envelope. Also checked SDK 0.6.132's `bundled-types/bb-plugin-sdk.d.ts` installed-plugin declarations (`enabled`, `id`, `providerIds`) and `PluginListResponse`.
- `bb-app/server/dist/start-server.js`, public routes: `GET /api/v1/plugins`, `POST /api/v1/plugins/:id/disable` (`{ ok: true, plugin }`), and `GET /api/v1/system/providers/catalog` (an array with `id`, `pluginId`, `pluginEnabled`, `enabled`). The catalogue waits for registrations but has a host-side timeout. The bundled plugin registry confirms the exact IDs above.
- The loopback `/internal/hosts/enroll-key` route is inherited pinned harness plumbing, not a public plugin API. Its optional `hostId` supports reenrollment of the same isolated host on restart.

## Keychain finding

The retained diagnosis at `/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/keychain-diagnosis/findings.md` reports that standalone Node bundled-CA and system-CA tests both succeeded without dialogs. In bb 0.49.0, host-connect installation-status prewarming checks all enabled providers, defaulting `checkUpdates` to true. The Claude provider then runs `claude doctor`. A substitute `security` executable, refusing real Keychain access, captured its attempted `add-generic-password` for `Claude Code-doctor-probe`. Historical logs show a matching item-creation operation immediately before the dialogs; attribution of that historical operation is strongly supported, not proven by an original command-line capture.

Disabling unrelated provider plugins **before host connection** passed the guarded startup-only check below. Removing Node's CA flag is not a demonstrated fix.

The supervisor's one monitored startup of retained candidate `6b08e681537897c365876375400b683cdc28bb86` failed after plugin installation with `fetch failed` / `ECONNRESET`, **before any provider disable or daemon enrollment/connection**. No Keychain events or guarded provider commands were observed; zero threads existed and recorded processes and ports were stopped. Retained monitor: `/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/keychain-diagnosis/startup-monitor-output.jsonl`; private root: `/private/var/folders/82/z689vjhj5f9f6xlwg34dn3vw0000gn/T/docket-bb-6KP63f`.

The supervisor independently reproduced the stale idle-socket failure with a separate server event loop and a blocked fetch client; `Connection: close` succeeded (`idle-socket-reproduction.mjs` and `idle-socket-result.json` in that diagnosis directory). The subsequent guarded startup of `194b442dbde7ff718ac70e45beaaa815e09fc278` passed on 11 November 2026, 09:02:45–09:03:23 Sydney time. Daemon connection, two-provider model catalogue prewarm, one-provider installation-status prewarm and the 30-second observation window completed. Only Pi and synthetic contributed enabled providers; Claude Code, Codex and ACP were independently verified disabled and selection was rechecked after the window. The independent monitor recorded **zero Keychain creation events and zero blocked credential/provider commands**. There were zero agent threads and no model prompts; the database contained one automatically created project, not zero projects. Every recorded process was absent and both ports refused connections; the guardian did not time out. Person configuration and Keychain were unchanged.

Evidence: `/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/keychain-diagnosis/startup-outcome.md` (including the earlier failed run) and `startup-194b442-verification.json` in the same directory. Retained root: `/private/var/folders/82/z689vjhj5f9f6xlwg34dn3vw0000gn/T/docket-bb-GZBzSf`. This is **startup-only evidence** for the pinned configuration/window. It does not prove historical attribution conclusively, restart admission, Q1a/Q1b, resource isolation or production readiness. This worker ran no live server/daemon, installed provider CLI, model, Electron or Keychain command. Do not automatically rerun a failed live entry.

## Build and offline checks

From the repository root:

```sh
npm run check
./node_modules/.bin/tsc -p bb/tsconfig.json
node --test tests/bb-admission-probe.test.ts tests/bb-control-http.test.ts tests/bb-provider-isolation.test.ts

BUILD_ROOT=$(mktemp -d -t docket-bb-build)
cp -R bb/plugin "$BUILD_ROOT/plugin"
mkdir "$BUILD_ROOT/home" "$BUILD_ROOT/data"
(cd "$BUILD_ROOT/plugin" && npm ci --ignore-scripts --no-audit --no-fund && npm run check)
env -i PATH="$PATH" HOME="$BUILD_ROOT/home" BB_DATA_DIR="$BUILD_ROOT/data" \
  BB_SERVER_URL=http://127.0.0.1:1 \
  node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb.js \
  plugin types "$BUILD_ROOT/plugin" --check
env -i PATH="$PATH" HOME="$BUILD_ROOT/home" BB_DATA_DIR="$BUILD_ROOT/data" \
  BB_SERVER_URL=http://127.0.0.1:1 \
  node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb.js \
  plugin build "$BUILD_ROOT/plugin"
```

The build command is offline with respect to the bb server; first use may download the pinned build toolchain. Keep dependency/build outputs in this scratch copy, not nested in the source workspace: the person-controlled root execution profile permits only root `node_modules/`. Generated `bb/plugin/dist/` and `bb/plugin/node_modules/` remain ignored as a safeguard, not permission to leave them there.

Seven admission/report tests, nine provider-selection policy tests and two local HTTP transport tests run in the ordinary root suite without bb installed, providers, credentials, models or Keychain access. Admission tests use real temporary SQLite, fresh database handles and a fake provider boundary, with project `defer` cleanup. The HTTP tests use only an owned local Node server process, including a deliberately blocked client interval and a reset mutation with no retry. Live harness process handling remains macOS-only and unqualified.

## Supervisor: one monitored startup only

For a separately authorised startup-only diagnostic, build as above and keep generated files outside the source workspace. From the clean committed workspace run:

```sh
DOCKET_BB_PROBE_PLUGIN="$BUILD_ROOT/plugin" node bb/probes/startup-only.ts
```

This is distinct from the authorised synthetic admission suite below. There is no `--pi` option or real-Pi creation in that suite.

The entry point starts only the isolated server/daemon and probe registration, reports the verified enabled provider plugins, waits **30 seconds** for startup prewarming to settle, reverifies selection and stops owned processes. It makes no project-create call, creates no agent threads and sends no prompts/model requests; bb may create its own default project. The check does not restart the server; restart ordering is covered by fakes until separately authorised live qualification.

An independent cleanup guardian imposes a **180-second deadline**, covering synchronous CLI calls too. It tracks owned process groups and observed descendants, including CLI children, and sends TERM then KILL on normal shutdown, signals, parent death or deadline. The deadline kills the parent after cleanup; allow roughly two extra seconds for cleanup. A failure before daemon connection must leave no daemon running.

The printed temporary `docket-bb-*` root is deliberately retained. Inspect `server.log`, `daemon.log`, `data/logs/`, `selected-providers.json`, `startup-only.json`, `guardian-stopped.json` and `stopped.json`. A hard deadline records `timedOut: true` in `guardian-stopped.json` and may leave no final parent report. These files are diagnostic evidence, not qualification. Retain the printed root and the external monitor's output for review; do not repeat a failed live check automatically. Remove only that exact temporary root once its evidence is retained and all recorded processes are confirmed stopped.

## Supervisor: synthetic admission suite (live results pending)

After stopping this worker, the supervisor may run **once**, under independent Keychain and provider-command guards. Build the scratch plugin as above from the exact clean committed candidate. Do not copy dependencies or bundles into the source tree. Run from that candidate's repository root:

```sh
DOCKET_BB_PROBE_PLUGIN="$BUILD_ROOT/plugin" node bb/probes/q1a.ts
```

The entry refuses arguments (including `--pi`), requires plain Node 26.7.0, bb 0.49.0 and SDK 0.6.132, checks scratch source bytes against the candidate and retains source/bundle SHA-256 values. Only `docket-synthetic` receives input. Pi remains enabled solely to preserve the guarded startup policy; it receives no test threads or prompts. No credentials, real models or installed provider CLI calls are requested. The synthetic bridge is local code, with no child process, tools or model calls. It records/fsyncs each input and deliberately fails turns to provide a genuine failed-request retry route. A fixture file selects a completed synthetic turn for terminal-fence tests.

An **independent 300-second guardian deadline** bounds the whole entry, including blocking CLI calls; allow roughly two seconds more for TERM/KILL cleanup. It also handles parent death and signals. Timeout updates the active report stage to failed. No automatic rerun. Logs/data remain in the printed private temporary root on success, assertion error or timeout.

Planned scenarios, each reported as passed, failed or not-run:

- Q1a: observe the plugin-owned queue row and wait decision before binding; crash/restart with the same durable data; bind and observe another wait; crash/restart after binding with no permission; permit once and recheck through ordinary queue drain. Consume must be durable before provider input. Consumed controls cannot revive the row.
- Q1a: retry the actual failed turn **by its `turn.failed.requestId`** through `bb.sdk.threads.retry`, then ordinary `thread tell --mode auto` and `--mode steer`. Retain attempted request and hook rejection evidence. No arbitrary delay stands in for dispatch observation.
- Q1a: race independent authenticated permit/refuse controls in both request orders. Await either queued rejection or an accepted failed turn, check at most one input, and validate permission/consumption history for every input. A fence can close a permitted row but never restore it to pending.
- Q1b: complete a synthetic turn, durably refuse it, archive, reload the enabled backend (generation must change), unarchive and attempt ordinary auto/steer sends. Retry the separately failed turn by reference too. Repeat across server/daemon restart, rechecking provider selection before reconnection and before further tests.
- Q1b: crash while a bound first input is held on the plugin-owned queue; restore the enabled plugin, observe it held again, fence it, refuse a late permit and observe rejection of the ordinary recheck.

`admission-report.json` retains exact versions/source, per-stage evidence, all provider inputs, durable ordered observations, selection, limitations and cleanup. `admission.jsonl` contains flushed durable-observation snapshots before hook answers. `guardian-stopped.json` records owned groups/descendants, timeout and remaining non-zombie processes; `stopped.json` records child exits and independently checked refused ports. Keep server/daemon logs and the external guard report as separate evidence. If a stage fails, remaining stages stay not-run; cleanup still runs. A cleanup failure makes the entry fail.

These experiments test an **independent probe SQLite database**, not actual Docket binding, authority, claims or trusted provenance. The hook accepts only the exact synthetic initial CLI text and a single matching queued member; grouped or non-initial input is refused. Permission, consumption and their observations commit together. This is deliberately not a Docket launcher.

Remaining gate gaps are explicit: UI and agent-origin submissions are not driven; steer mode targets an idle/fenced thread, not a live turn; retry of a completed turn may be refused by host preconditions rather than the hook (failed-turn retry covers the actual retry dispatch path); crashes cover persisted hook waits, not a callback paused mid-execution. Q1c uncertain create/send, real-provider recovery/terminal observation, Q2 isolation, actual Docket authority/provenance and production qualification remain unproven. Deliberate plugin disable/unload/replacement and Send now/queue send remain outside the guarantee and are never used by the suite.

### Additional pinned contract checks

Read SDK 0.6.132's backend and provider-bridge declarations and bb 0.49.0's installed CLI/daemon source:

- `thread-MZN2MO7V.js`: spawn JSON is the thread DTO; show JSON is **`{ thread: DTO, ... }`**; queue list is an array. Retry accepts `--turn`, but the suite uses the backend SDK route with a recorded failure reference. Token JSON is `{ ok, token }`; tokens are never printed or retained.
- `MessageDispatchHookContext`: `input.blocks` and each queued row's `content` are **block arrays**, not strings; `input.text` is combined text. Every member is inspected. Thread provider is `providerId`. Hook wait/reject/proceed are admission decisions; lifecycle events cannot veto input.
- Installed `daemon-bundle.mjs`, `BY`/`NY`: `model/list` results require **both `models` and `selectedOnlyModels`**. Available models need model/display/description/default reasoning fields. Start/resume pass cwd/options and identity; turn/start passes input/clientRequestId. The bridge validates published parameter and delta schemas and keeps cwd per thread. It records any unexpected start-time input too, which fails final input validation instead of disappearing from the count.
- `plugin-K4RLPVUQ.js`: plugin reload uses `/api/v1/plugins/reload?id=...`; install waits; token supports JSON. All HTTP controls, including authenticated probe state/control/retry, use the shared fresh-connection helper and never retry a mutation. Non-success errors do not echo token values or request/response bodies.
