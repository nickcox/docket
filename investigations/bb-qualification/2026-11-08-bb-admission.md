# Docket bb admission probe – 8 November 2026

## Versions and scope

- Host: macOS 27.0.1, bb 0.49.0, plugin SDK 0.6.132.
- Provider for the disposable thread: Codex plugin 0.1.1, `gpt-6-luna`, low reasoning.
- Probe plugin: `docket-qualification-probe`, a local headless plugin with a `message.dispatch` hook. It returned `wait` only when the input contained `DOCKET_Q1_PROBE_20261108`. The [probe source](probe-server.ts) is retained with this record; the plugin was uninstalled after the test.
- Test thread: @thread:thr_ip9mu4fbpg in a separate personal workspace. Its prompt requested the single word `admitted` and no tools or file changes.

## Observation – Q1b plugin-unload case

1. With the plugin enabled, bb created the thread in `pending` state with one queued message. The plugin logged `Held DOCKET_Q1_PROBE_20261108 for thread thr_ip9mu4fbpg`. The thread had no assistant output.
2. Disabled only `docket-qualification-probe` with `bb plugin disable docket-qualification-probe`.
3. The thread reached `idle`, its queued message count became zero, and `bb thread output thr_ip9mu4fbpg` returned `admitted`. The timeline shows one provider reply.

**Result:** a `message.dispatch` hook can hold the initial message while loaded, but its wait does not enforce a durable admission or terminal fence while the plugin is disabled. The hook-only design fails the plugin-unload part of Q1b and must not qualify the bb launcher.

## Remaining qualification

- Q1a: binding, first-message races and at-most-one provider admission remain untested. This probe only established that the hook held the first message before unload.
- Q1b: retries, unarchive and server restart remain untested. The plugin-unload case already rules out a hook-only fence.
- Q1c: lost create/send response and replay remain untested.
- Q2a–Q2c: execution-profile isolation, trustworthy terminal observation and retained lease behaviour remain untested. A dedicated worker provider or another independent admission mechanism must exist before these can qualify the bb launcher.

An attempted follow-up after unarchiving this disposable thread was refused by bb with `Thread environment is unavailable`: archiving had removed its personal workspace and that provider could not restore it. This is an environment refusal, not evidence of a Docket terminal fence. The test thread was archived again.

The current [adapter specification](../../docs/specification/adapters.md#qualification-gates) requires all gates to pass for the intended provider and host versions. This probe does not qualify that combination.
