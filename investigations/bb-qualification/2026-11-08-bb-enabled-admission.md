# Docket bb enabled-plugin admission probe – 8 November 2026

## Versions and scope

- Host: macOS 27.0.1, bb 0.49.0, plugin SDK 0.6.132.
- Provider: Codex plugin 0.1.1, `gpt-6-luna`, low reasoning, `accept-edits` permission mode.
- Probe: local headless `docket-qualification-enabled` plugin 0.1.0 with a `message.dispatch` hook. Its [source](enabled-probe-server.ts) is retained here. The binding state was a file in a temporary directory, not a Docket core transaction.
- Threads: @thread:thr_tnayguy8y3 (wait and manual send), @thread:thr_7r5zxx5ygr (permitted binding) and @thread:thr_768yjh2g4q (fenced binding). All were hidden disposable Personal threads. Prompts requested a single reply and no tools.

## Observations

1. The first prompt on `thr_tnayguy8y3` contained `DOCKET_Q1_WAIT_20261108`. With the plugin enabled, the hook returned `wait`; the thread was pending with one plugin-held queue row and no timeline events. Explicit `bb thread queue send` returned `delivery: sent`. The provider replied `ADMITTED` and completed one turn while the plugin was still running.
2. A queued prompt on the same thread contained `DOCKET_Q1_REJECT_20261108`. The hook logged a rejection. Explicit `bb thread queue send` still returned `delivery: sent`; the provider replied `ADMITTED2` and completed a second turn. Ordinary `bb thread tell --mode auto` with that marker returned HTTP 409 `dispatch_rejected`. It also returned 409 after a normal reload of the enabled plugin.
3. The first prompt on `thr_7r5zxx5ygr` contained `DOCKET_Q1_BOUND_20261108`. With no binding file, the hook held it in the queue and the timeline was empty. After the test wrote `permitted` for that thread, a timed queue recheck passed through the hook. It changed the test state to `used`, and the provider replied `BOUND_ADMITTED` in one completed turn. A second ordinary follow-up with the marker returned HTTP 409 `Docket binding used`.
4. The first prompt on `thr_768yjh2g4q` was also held with no binding file and an empty timeline. After the test wrote `fenced`, a timed queue recheck returned `Docket binding fenced`. The queue row became `failed_retrying`; no provider turn began. The row was deleted before the plugin was removed.

All three queues were confirmed empty, all threads were archived, and the disposable plugin was removed.

## Interpretation and remaining work

The enabled hook controlled ordinary follow-ups and timed queue rechecks in this probe. Explicit `bb thread queue send` bypassed its wait and reject decisions. The user accepted that manual Send now path as outside the bb launcher guarantee, along with deliberate plugin disable, unload or replacement. The [adapter specification](../../docs/specification/adapters.md#bb-launcher) now states that boundary.

This is a host-behaviour probe, not Q1 qualification. The file-backed state did not test Docket's transactional reference binding or claim ownership. Q1a still needs crash and race tests with the real binding. Q1b still needs a real terminal worker, ordinary retries and unarchive, plus backend reload and bb restart with the plugin enabled. Q1c lost create/send acknowledgement and Q2a–Q2c remain untested. No bb launcher is qualified by this probe.
