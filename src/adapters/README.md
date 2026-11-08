# External-owner adapters

These internal adapters implement R31's result contract and R32's owner boundaries. They do not write task, attempt, claim or effect records. The caller records intent and reconciles uncertain outcomes before authorising any further effect.

- `GitRepository` inspects refs and workspaces, compares exact commits, lists changed paths, verifies retention, pins refs, conditionally moves/deletes/fast-forwards refs and prepares detached rebases.
- `TreehouseWorkspace` acquires, inspects/lists and returns exact allocations, and identifies recyclable roots. It always selects an explicit pool root and disables acquisition fetches.
- Every public operation returns `confirmed`, `rejected` or `uncertain`. An absent ref/lease is a confirmed observation only after a complete successful lookup in the correct owner scope. Effects are attempted once. Additional reads are verification, not effect retries.

## Allocation identity

Configure a canonical backing checkout, an absolute pool root and an absolute receipt directory outside the pool. Each allocation contains the lease ID, holder, canonical workspace path, pool identity, canonical Git common directory, branch and verified starting commit. A path alone cannot inspect or return a lease.

Treehouse status does not report the original commit after a worker changes HEAD. The adapter therefore writes a create-only acquisition receipt, keyed by the lease ID, after verifying the live lease, branch, repository and starting HEAD. Receipts must remain in retained, person-controlled storage. They preserve acquisition evidence, not lease authority: every inspection also reads Treehouse and Git. Missing or malformed receipts make the allocation unknown. Receipts survive return and may be retained with the attempt's other evidence; deleting one does not return its lease. Do not edit them to reconcile a mismatch.

Acquisition creates a private branch derived from the database and attempt IDs with Git's create-only protection. Even an existing ref at the requested commit refuses another acquisition. A successful acquisition conditionally removes the private ref at its original value. A moved ref is preserved, with the verified allocation included in the uncertain result's reference hints. Lost/malformed acquisition output also remains uncertain and is never automatically acquired again.

Pool identity follows Treehouse's origin URL, or its canonical backing checkout path when there is no origin, together with the canonical pool root. Changing the origin can hide leases from a previous pool. Inspecting such an allocation is unknown, never absent.

## Git effects and return

Ref mutations use Git's expected-old-value protection and do not follow symbolic refs. Move/delete refuse checked-out refs. Fast-forwarding a checked-out target first refuses tracked or untracked changes, then prepares a Git ref transaction at the expected commit. While that transaction holds the ref lock, the adapter rechecks the workspace and updates its index/worktree with a two-tree `read-tree -m -u`. Only then does it commit the ref transaction. The worktree is verified afterwards. Linked worktrees follow the same path. A stopped transaction after worktree changes is uncertain and requires inspection, not an automatic rollback or retry.

As with ordinary Git commands, callers must prevent unrelated simultaneous edits or checkout operations in a worktree. Git's ref lock protects against a concurrent ref move, not arbitrary filesystem writes. A process interruption between updating the worktree and committing the ref can leave a mismatch; the uncertain outcome preserves that fact.

Return accepts an explicit authorised core request and the core-selected retention requirements. It checks the exact live allocation, rechecks exact Git reachability and readable regular artefacts outside recyclable roots, and checks the allocation again before Treehouse's holder/lease-ID-conditional return. It never forces dirty changes away. A successful command alone does not prove return: a complete subsequent listing of the same pool must also confirm it.

Rebase passes exact commit IDs, disables automatic stash/ref updates and runs detached. Conflicts leave the workspace for inspection without moving the accepted/source branches. It does not automatically abort or resolve them.

## Standalone Pi

`PiLauncher` implements R31/R35 over the Pi RPC JSONL protocol. Construct it in the trusted, long-lived worker owner, with an absolute retained state directory outside the lease and person-controlled execution profiles. Each profile names an absolute executable, an optional absolute Node entrypoint, one credential environment variable and an explicit list of additional environment variable names. Unknown options and `DOCKET_` names refuse. The adapter snapshots this configuration and the host environment at construction.

Use `prepareWorker` and `activateWorker` for durable effects. The mandatory `admit` callback is trusted host code, not worker input. Immediately before the prompt, it must call `db.checkWorkerEffect(effectId, { claimId, generation })` for the owning claim and compare the effect's operation (`worker.activate`), attempt, `target.reference` and `input.specification` with the supplied values. That core read verifies committed permission, the full bound reference, the claimed effect and fresh ownership. An absent/mismatched effect must refuse or throw. The callback does not claim the effect again. The synthetic-Pi operation tests demonstrate this binding.

Preparation creates a fresh private home and session directory, selects the exact provider/model/reasoning and validates the returned idle session identity before confirming. It never sends a prompt. The private `HOME` intentionally replaces the host's home, excluding user settings, auth/model files and system prompts. Other approved base/proxy variables and configured credential/pass-through references retain their host values when present. Project approval, extensions, MCP, skills, templates, themes and context discovery are disabled. No general host environment is inherited. On macOS, CoreFoundation may itself add `__CF_USER_TEXT_ENCODING` inside the child; the launcher does not pass it.

These are resource-loading controls, not an OS sandbox. Native coding tools remain available. A person who explicitly allows runtime configuration variables such as `NODE_OPTIONS` or `PI_CODING_AGENT_DIR` is trusting their effects, including changes to resource loading. Executables, the retained state root and execution profiles must remain person-controlled. The owning host, not the transport, enforces run deadlines and budget policy.

Activation consumes its one prompt attempt before writing. A timeout, malformed acknowledgement or lost reply stays uncertain, even if a turn ends afterwards. Concurrent/replayed activation cannot send twice. Turn events and idle preparation are separate from observed direct-child exit. Stop/fence use bounded TERM/KILL and confirm only after the child exit event; neither a signal request nor pipe EOF proves termination. No claim is made about descendants. A new adapter owner cannot adopt a PID or infer absence: references it does not own are unknown. It never restarts a worker.

Usage reads cumulative `get_session_stats`, not per-turn deltas. Missing/invalid values and failed reads are unknown; an explicit unsupported-command reply is unsupported. Regressing counters refuse reporting. The latest reported snapshot remains available after exit. Result transport returns only a bounded, single-link regular-file path in retained storage; the core must open and validate the result, its identity and retention before completion or acceptance. The prompt carries worker protocol version 1 as JSON, including the exact allocation, instructions, ordered criteria, delivery contract and result/question paths.

The implementation consulted the **Pi** reference entry pinned at Switchboard `4077c10009c0ea895e990753d831a20e2fefaf15`: `rpc-client.ts`, `jsonl.ts` and `worker.ts`. It also checked the installed Pi CLI and RPC command documentation. Synthetic peers exercise the process boundary by default. Set `DOCKET_TEST_REAL_PI=1`, `DOCKET_TEST_PI_EXECUTABLE` (absolute), `DOCKET_TEST_PI_PROVIDER` and `DOCKET_TEST_PI_MODEL` to enable the optional real-Pi preparation/fencing probe. It sends no prompt or model request and is not real-dispatch release qualification.

## Verification

`npm run check` and `npm test` include real temporary Git repositories and isolated real Treehouse pools. Treehouse must be installed; adapter tests are not silently skipped. The implementation uses `git show-ref --exists` (Git 2.46 or later) so missing refs are distinct from lookup failures. Qualification here used Node 26.7.0, Git 2.53.0 and Treehouse 3.1.4 on macOS.

The implementation consulted the **Treehouse and Git** reference entry pinned at Switchboard `4077c10009c0ea895e990753d831a20e2fefaf15`: `treehouse.ts`, `retention.ts`, `integration.ts`, `output-branch.ts` and `starting-point.ts`. Docket's specification governs the contract; notably checked-out fast-forwards use a ref transaction rather than an unprotected read followed by merge.
