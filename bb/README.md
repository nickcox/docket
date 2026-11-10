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

### Installed contract evidence

Inspected the installed code, without executing a live server or provider:

- `bb-app/host-daemon/dist/bb-chunks/plugin-K4RLPVUQ.js`, `registerPluginCommands`: `plugin list --json` returns **`{ plugins: [...] }`**, not an array. `plugin disable <id> --json` returns `{ ok, plugin }`. Installation waits unless `--no-wait` is supplied.
- `bb-app/dist/index.js`, installed-plugin and runtime-status schemas: inventory rows have `id`, `enabled`, `status`, `providerIds`; `starting` is not ready. SDK `plugins.list()` preserves the envelope. Also checked SDK 0.6.132's `bundled-types/bb-plugin-sdk.d.ts` installed-plugin declarations (`enabled`, `id`, `providerIds`) and `PluginListResponse`.
- `bb-app/server/dist/start-server.js`, public routes: `GET /api/v1/plugins`, `POST /api/v1/plugins/:id/disable` (`{ ok: true, plugin }`), and `GET /api/v1/system/providers/catalog` (an array with `id`, `pluginId`, `pluginEnabled`, `enabled`). The catalogue waits for registrations but has a host-side timeout. The bundled plugin registry confirms the exact IDs above.
- The loopback `/internal/hosts/enroll-key` route is inherited pinned harness plumbing, not a public plugin API. Its optional `hostId` supports reenrollment of the same isolated host on restart.

## Keychain finding

The retained diagnosis at `/Users/nick/.bb/thread-storage/thr_i4r9iqub7v/keychain-diagnosis/findings.md` reports that standalone Node bundled-CA and system-CA tests both succeeded without dialogs. In bb 0.49.0, host-connect installation-status prewarming checks all enabled providers, defaulting `checkUpdates` to true. The Claude provider then runs `claude doctor`. A substitute `security` executable, refusing real Keychain access, captured its attempted `add-generic-password` for `Claude Code-doctor-probe`. Historical logs show a matching item-creation operation immediately before the dialogs; attribution of that historical operation is strongly supported, not proven by an original command-line capture.

Disabling unrelated provider plugins **before host connection** addresses that startup path. Removing Node's CA flag is not a demonstrated fix. This worker did not run bb startup, provider CLIs, models or Keychain commands. The supervisor must review first, then perform exactly one monitored startup.

## Build and offline checks

From the repository root:

```sh
npm ci --prefix bb/plugin --ignore-scripts --no-audit --no-fund
npm run check
npm run check --prefix bb/plugin
./node_modules/.bin/tsc -p bb/tsconfig.json
node --test tests/bb-provider-isolation.test.ts

BUILD_ROOT=$(mktemp -d -t docket-bb-build)
mkdir "$BUILD_ROOT/home" "$BUILD_ROOT/data"
env -i PATH="$PATH" HOME="$BUILD_ROOT/home" BB_DATA_DIR="$BUILD_ROOT/data" \
  BB_SERVER_URL=http://127.0.0.1:1 \
  node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb.js \
  plugin build bb/plugin
```

The build command is offline with respect to the bb server; first use may download the pinned build toolchain. Generated `bb/plugin/dist/` and `bb/plugin/node_modules/` remain ignored. The nine fake tests run in the ordinary root suite on all CI platforms, without bb installed or any live programs, filesystem fixtures, credentials, models or Keychain access. Live harness process handling remains macOS-only and unqualified.

## Supervisor: one monitored startup only

After building, from this exact workspace, run:

```sh
node bb/probes/startup-only.ts
```

Do **not** run `bb/probes/q1a.ts` or its `--pi` option for this check.

The entry point starts only the isolated server/daemon and probe registration, reports the verified enabled provider plugins, waits **30 seconds** for startup prewarming to settle, reverifies selection and stops owned processes. It creates no projects or agent threads and sends no prompts/model requests. The check does not restart the server; restart ordering is covered by fakes until separately authorised live qualification.

An independent cleanup guardian imposes a **180-second deadline**, covering synchronous CLI calls too. It tracks owned process groups and observed descendants, including CLI children, and sends TERM then KILL on normal shutdown, signals, parent death or deadline. The deadline kills the parent after cleanup; allow roughly two extra seconds for cleanup. A failure before daemon connection must leave no daemon running.

The printed temporary `docket-bb-*` root is deliberately retained. Inspect `server.log`, `daemon.log`, `data/logs/`, `selected-providers.json`, `startup-only.json`, `guardian-stopped.json` and `stopped.json`. A hard deadline records `timedOut: true` in `guardian-stopped.json` and may leave no final parent report. These files are diagnostic evidence, not qualification. Retain the printed root and the external monitor's output for review; do not repeat a failed live check automatically. Remove only that exact temporary root once its evidence is retained and all recorded processes are confirmed stopped.
