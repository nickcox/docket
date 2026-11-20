# bb 0.49.0 live qualification record

Live testing began on 2026-11-18. The run summary, raw CLI responses and bb logs are in `/Users/nick/.bb/thread-storage/thr_9eg4t6nz6e/bb-qualification/`.

## Versions and environment

The runs used bb 0.49.0 and plugin SDK 0.6.132 on one macOS machine. The bb provider was `pi`, using Pi's default model `openai-codex/gpt-6.1-sol` with reasoning set to medium. The bb project was `docket`, and the plugin's `projects` setting was limited to that project. Docket used the `bb-worker` profile and the `bb.local` execution profile. The profile set a 3,000,000-token limit and no cost limit.

## Results

These results use the [qualification gates](../specification/adapters.md#qualification-gates).

### Q1a – First-prompt admission

In attempt `1cdfb510`, the hook held the first prompt, but activation failed because the pending bb thread did not yet have an environment attached. After the launcher fix in `e9db822`, attempt `0c9ba90d` (thread `thr_zvv9fsrb5e`) ran on Docket `main` at `c21df86`. The hook held the prompt until Docket bound the thread and committed permission, then admitted it once. The worker completed and candidate `ac6ea52` passed Docket's checks.

In attempt `153e387c` (thread `thr_8qjwfba653`), the dispatch process was killed after committing permission, with the first prompt still held. A person's recheck 22 seconds later admitted the prompt once. The owner's last heartbeat was still fresh, and the admission was after committed permission.

In attempt `9512b5fa` (thread `thr_5r37sxiz3f`), bb retried the held prompt on its own as capacity freed. The hook admitted it once, after permission but before the launcher's recheck. The launcher found no held row and wrongly recorded activation and recheck as rejected. An emergency stop cancelled provisioning before a turn began. Commit `58177a0` fixed the launcher defect.

**Result: Pass** for the normal path and the crash after permission. A fence racing activation in separate processes and grouped queue members across concurrent senders are covered only by offline tests.

### Q1b – Later-turn refusal and detection

On the finished worker for `0c9ba90d` (thread `thr_zvv9fsrb5e`), the hook refused steer and queue sends with HTTP 409 and no new turn. It refused a scheduled send at creation, so no queue row existed for Send now to release. With the plugin disabled, a send bypassed the hook and the resulting turn committed `0238cf5`. After the plugin was enabled again, ordinary sends were refused. A writable acceptance attempt detected the later turn and refused with `result_discrepancy`. Read-only operations initially reported `owner_unknown`; `48af020` fixed them to report the later-turn discrepancy.

Attempt `50751750` (thread `thr_n446ceepam`) completed, candidate `b416963` passed Docket's checks and was accepted onto `main`, and the lease returned. After a bb restart, the first ordinary send to that finished worker was refused with HTTP 409. The thread log was unchanged at 52 events and one turn start, showing that the hook was registered before the send reached it.

**Result: Pass** for steer, queue and scheduled sends, with ordinary dispatch refusal observed again after a plugin reload and a bb restart. Docket detected the bypass as a later turn.

### Q1c – Uncertain create or send

In attempt `6e02f7c7`, the dispatch process was killed during `worker.prepare`. No bb thread was created. Docket left the effect unresolved and, once the heartbeats went stale, blocked dispatch with `claim_unresolved` without retrying. A person resolved the effect and claims, then discarded the attempt and returned the lease.

**Result: Partly run.** This shows only that Docket preserves the unresolved effect and blocks dispatch without retrying. A create or send whose response was lost after bb acted has not been run live.

### Q2a – Worker identity and loaded resources

The worker for `0c9ba90d` (thread `thr_zvv9fsrb5e`) ran in the leased Treehouse worktree on the attempt's output branch, with provider `pi` and model `openai-codex/gpt-6.1-sol`. It loaded:

- 43 skills from the personal, `twg` and bb global collections and `docket-plugin`.
- The personal Pi `AGENTS.md` and the repository `AGENTS.md` as context files.
- The bb plugin instructions `bb-guide`, `browser-automation` and `workflows`.
- The tools `read`, `bash`, `edit`, `write` and `web_enable`.

The worker received `BB_CLI`, `BB_SERVER_URL`, `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, `BB_THREAD_STORAGE` and `BB_HOST_DAEMON_PORT`, and could run `bb` commands as itself. It edited files, ran `npm run check && npm test` and committed to the attempt's output branch, writing to the backing repository's `.git`.

**Result: Recorded.**

### Q2b – Interrupted and completed turns

In the Q1a crash run (`153e387c`), the owner was gone while the turn ran. A person stopped the worker mid-turn. Dispatch stayed blocked, and recovery initially refused even though the thread had stopped. After `ef336cd`, the person could resolve the effects and worker claim, discard the attempt and return the lease. The restart probe for `50751750` observed a finished worker after a bb restart, with no new turn in the thread log.

**Result: Partly run.** An interrupted turn across a plugin reload has not been run live. A live comparison of provider events, thread state, queued inputs and result for an interrupted turn across a bb restart is also outstanding.

### Q2c – Workspace retention

Attempt `2d174836` (thread `thr_389ehessaz`) ran on `58177a0`. Candidate `8e2da08` passed checks and waited for acceptance while the lease was still held. bb refused to delete the environment record with HTTP 409 while the thread held it. After the thread was archived, the record was deleted and reached `destroyed`. bb did not run teardown on the leased folder; the folder, branch at `8e2da08` and worker's file were intact and clean.

Initially, Docket could not read the worker because the destroyed environment record no longer supplied a path. After `f93c30b`, dry-run acceptance read the worker normally and refused only because `main` had moved (`not_fast_forward`). The attempt was then discarded and its lease returned.

**Result: Pass** for refusal while a live thread holds the environment record, retention of the leased folder and Docket's ability to read the worker after the record is deleted.

### Summary

| Gate | Result | Scope |
| --- | --- | --- |
| Q1a | Pass | Normal path and crash after permission: one admission, after permission. Separate-process fence/activation and concurrent grouped-sender cases are offline only. |
| Q1b | Pass | Ordinary sends refused, including after reload and restart; bypass detected. |
| Q1c | Partly run | Unresolved creation blocked dispatch without retry; no live response loss after bb acted. |
| Q2a | Recorded | Worker environment, resources and capabilities. |
| Q2b | Partly run | Owner absent mid-turn and finished worker after restart observed; interrupted-turn reload and restart probes outstanding. |
| Q2c | Pass | Live-thread deletion refused; workspace retained and worker readable after record deletion. |

## Limits found

- For up to 30 seconds after an owner process dies, a recheck can still start its worker while the last heartbeat is fresh. The worker then runs without a Docket owner. See [bb launcher](../bb-launcher.md).
- A later turn after lease return can change a workspace reused by another attempt.

## Fixes made during qualification

- `e9db822` – Handle pending bb threads before environment attachment
- `a42ae70` – Withdraw pending worker effects on terminal discard
- `c21df86` – Withdraw pending worker effects when replaying terminal discard
- `48af020` – Report unrecorded bb later turns during read-only inspection
- `ef336cd` – Let person recovery accept a stopped bb worker without terminal proof
- `58177a0` – Preserve bb activation admission across queue races
- `f93c30b` – Inspect bb workers after their environment record is destroyed

## Cost

The provider does not report model cost; Docket records cost as unsupported. Final token totals and worker time from Docket's usage records:

| Attempt | Tokens | Worker time |
| --- | ---: | ---: |
| `0c9ba90d` | 30,332 | 216 s |
| `50751750` | 17,880 | 209 s |
| `2d174836` | 27,262 | 198 s |

Attempts `1cdfb510`, `6e02f7c7`, `153e387c` and `9512b5fa` recorded no usage because they stopped before or during the worker's turn.

## M1 status

[M1](../specification/delivery.md#verification-milestones) is not yet met for bb. Q1c still needs a live run where the create or send response is lost after bb acts. Q2b still needs the interrupted-turn runs across plugin reload and bb restart described above. Everything else that M1 requires for bb is recorded here.
