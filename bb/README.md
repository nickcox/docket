# Experimental bb harness – unqualified

Restored **only `bb/`** from retained Docket commit `304333f`, then repaired startup. This is unfinished experimental work, not a production Docket launcher. Q1a, Q1b, Q1c and Q2 remain unproven. The inherited admission probe has not been repaired or accepted by this task. Full Q1a execution and real-Pi model runs are deferred.

## Startup repair (R31, R33)

The macOS live harness requires plain Node 26.7.0, installed bb 0.49.0 at `/Applications/bb.app`, and plugin SDK 0.6.132. It never launches Electron. It creates a private temporary home/data directory and two non-default loopback ports. No normal bb configuration or Keychain changes are needed or permitted.

Startup now:

1. Starts the separate server, with no daemon connected.
2. Reads the public provider catalogue, whose handler waits for initial registration. That wait can time out inside bb, so the harness also polls the plugin inventory: all four pinned builtin provider plugins must be present, enabled ones must be running and represented in the catalogue, and no plugin may still be `starting`.
3. Installs the experimental `docket-probe` plugin, awaiting installation completion. Its provider is `docket-synthetic`.
4. Disables `provider-claude-code`, `provider-codex` and `provider-acp` using public plugin disable operations. Checks each response, then independently rereads both inventories. Only `provider-pi` (`pi`) and `docket-probe` (`docket-synthetic`) may contribute enabled providers. Missing Pi, malformed/failed reads, failed disables, incomplete registration or an unexpected enabled provider refuse enrollment/connection.
5. Only then mints the isolated host enrollment key and starts the daemon.

`provider-retry` and `bb--provider-usage` are not agent provider plugins and are not changed. Unknown `provider-*` plugins (apart from `provider-retry`) and any unexpected plugin with registered provider IDs are refused, not silently trusted.

For a controlled server restart, the daemon and its observed descendants are stopped **before** restarting the server. The same private data persists. Registration and provider selection are checked again before daemon reconnection; lost selection is refused rather than silently repaired. This changes the experimental restart plumbing, not a claim that the inherited Q1 experiments pass.

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

Disabling unrelated provider plugins **before host connection** is the intended mitigation for that startup path, but remains unverified live. Removing Node's CA flag is not a demonstrated fix.

The supervisor's one monitored startup of retained candidate `6b08e681537897c365876375400b683cdc28bb86` failed after plugin installation with `fetch failed` / `ECONNRESET`, **before any provider disable or daemon enrollment/connection**. No Keychain events or guarded provider commands were observed; zero threads existed and recorded processes and ports were stopped. Retained monitor: `/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/keychain-diagnosis/startup-monitor-output.jsonl`; private root: `/private/var/folders/82/z689vjhj5f9f6xlwg34dn3vw0000gn/T/docket-bb-6KP63f`.

The supervisor independently reproduced the stale idle-socket failure with a separate server event loop and a blocked fetch client; `Connection: close` succeeded (`idle-socket-reproduction.mjs` and `idle-socket-result.json` in that diagnosis directory). This repair has only local HTTP and fake-policy test evidence. This worker did not run bb startup, provider CLIs, models or Keychain commands. Successful live startup, the Keychain mitigation, Q1a and bb qualification remain unproven. Another supervised live startup requires a separate explicit decision; do not repeat it automatically.

## Build and offline checks

From the repository root:

```sh
npm run check
./node_modules/.bin/tsc -p bb/tsconfig.json
node --test tests/bb-control-http.test.ts tests/bb-provider-isolation.test.ts

BUILD_ROOT=$(mktemp -d -t docket-bb-build)
cp -R bb/plugin "$BUILD_ROOT/plugin"
mkdir "$BUILD_ROOT/home" "$BUILD_ROOT/data"
(cd "$BUILD_ROOT/plugin" && npm ci --ignore-scripts --no-audit --no-fund && npm run check)
env -i PATH="$PATH" HOME="$BUILD_ROOT/home" BB_DATA_DIR="$BUILD_ROOT/data" \
  BB_SERVER_URL=http://127.0.0.1:1 \
  node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb.js \
  plugin build "$BUILD_ROOT/plugin"
```

The build command is offline with respect to the bb server; first use may download the pinned build toolchain. Keep dependency/build outputs in this scratch copy, not nested in the source workspace: the person-controlled root execution profile permits only root `node_modules/`. Generated `bb/plugin/dist/` and `bb/plugin/node_modules/` remain ignored as a safeguard, not permission to leave them there.

The nine fake policy tests and two local HTTP transport tests run in the ordinary root suite without bb installed, providers, credentials, models or Keychain access. The HTTP tests use only an owned local Node server process, including a deliberately blocked client interval and a reset mutation with no retry. Live harness process handling remains macOS-only and unqualified.

## Supervisor: one monitored startup only

Only after a separate explicit decision authorising another monitored startup: build as above, temporarily copy the scratch plugin's `dist/` into `bb/plugin/dist/` for installation, then from this exact workspace run:

```sh
node bb/probes/startup-only.ts
```

Do **not** run `bb/probes/q1a.ts` or its `--pi` option for this check.

The entry point starts only the isolated server/daemon and probe registration, reports the verified enabled provider plugins, waits **30 seconds** for startup prewarming to settle, reverifies selection and stops owned processes. It creates no projects or agent threads and sends no prompts/model requests. The check does not restart the server; restart ordering is covered by fakes until separately authorised live qualification.

An independent cleanup guardian imposes a **180-second deadline**, covering synchronous CLI calls too. It tracks owned process groups and observed descendants, including CLI children, and sends TERM then KILL on normal shutdown, signals, parent death or deadline. The deadline kills the parent after cleanup; allow roughly two extra seconds for cleanup. A failure before daemon connection must leave no daemon running.

The printed temporary `docket-bb-*` root is deliberately retained. Inspect `server.log`, `daemon.log`, `data/logs/`, `selected-providers.json`, `startup-only.json`, `guardian-stopped.json` and `stopped.json`. A hard deadline records `timedOut: true` in `guardian-stopped.json` and may leave no final parent report. These files are diagnostic evidence, not qualification. Retain the printed root and the external monitor's output for review; do not repeat a failed live check automatically. Remove only that exact temporary root once its evidence is retained and all recorded processes are confirmed stopped.
