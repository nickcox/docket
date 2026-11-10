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

## Acceptance and finalisation

`acceptCandidate` in `src/completion.ts` uses the repository and check adapters, records exact-candidate acceptance, and separately confirms integration and task completion. `automaticReturn` follows acceptance and held/failed dispatch outcomes, returning a safe lease or reporting why it was kept. A person can also call `returnAttempt` explicitly with the same retention, terminal, allocation, clean-workspace and unresolved-effect checks. Neither requires confirmation about processes the worker started. Its optional `discard: { leaseId, confirmed: true, reason }` requires a nonblank reason. Neither operation infers process termination from a successful check. Replaying an interrupted operation inspects its durable steps; a claimed or uncertain effect is never called again. Exact target reachability or an absent lease in the recorded pool can confirm a lost response. Otherwise the uncertainty remains for explicit resolution.

`completionWorkspace(treehouse)` bridges the stored holder/repository/pool-root fields to the adapter's immutable acquisition receipt. Acquisition must encode the structured holder as canonical JSON. The bridge reads the receipt with `recordedAllocation`, then inspects the full original pool identity; an origin change cannot masquerade as an absent lease. The receipt alone never proves return.

Repository restrictions are read from `.docket/finalisation.json` in the trusted target commit. Operator restrictions are read from the configured `globalFile`, or `~/.config/docket/finalisation.json` when it is null. An absent conventional operator file or absent repository file adds no restrictions; an explicit missing operator file, unreadable file, malformed JSON or linked repository policy refuses. The fixed schema is:

```json
{ "version": 1, "forbid": ["local-merge"], "protectedTargets": ["main"] }
```

Both arrays are required. `forbid` entries name `local-merge` or an exact target; `protectedTargets` entries name exact branches, either short or full refs. Unknown fields, including executable policy fields, refuse. Recorded and current context restrictions, operator files and the trusted repository restrictions add up. Protection and policy are re-read before integration, and a changed target refuses the planned fast-forward. Manual acceptance keeps the output ref without claiming integration.

Return rechecks retained result/artefact digests as well as Git reachability. Cleanup has its own conditional-delete effect after confirmed return, and only integrated or explicitly discarded output is eligible. Moved refs are preserved. Cleanup failure or uncertainty stays visible in its request without reversing the return.

## Standalone Pi

`PiLauncher` implements R31/R35 over the Pi RPC JSONL protocol. Construct it in the trusted, long-lived worker owner, with an absolute retained state directory outside the lease and person-controlled execution profiles. Each profile names an absolute executable, an optional credential environment variable and an explicit list of additional environment variable names. For a CLI or synthetic peer it can name an absolute Node entrypoint. For shared Pi agent files it instead names an absolute installed Pi SDK module (`sdkModule`), with Node as the executable. Unknown options and `DOCKET_` names refuse. The adapter snapshots this configuration and the host environment at construction.

Use `prepareWorker` and `activateWorker` for durable effects. The mandatory `admit` callback is trusted host code, not worker input. Immediately before the prompt, it must call `db.checkWorkerEffect(effectId, { claimId, generation })` for the owning claim and compare the effect's operation (`worker.activate`), attempt, `target.reference` and `input.specification` with the supplied values. That core read verifies committed permission, the full bound reference, the claimed effect and fresh ownership. An absent/mismatched effect must refuse or throw. The callback does not claim the effect again. The synthetic-Pi operation tests demonstrate this binding.

Preparation creates a fresh private home and session directory, selects the exact provider/model/reasoning and validates the returned idle session identity before confirming. It never sends a prompt. The private `HOME` intentionally replaces the host's home, excluding user settings, unapproved auth/model files and system prompts. Other approved base/proxy variables and configured credential/pass-through references retain their host values when present. Project approval, extensions, MCP, skills, templates, themes and context discovery are disabled. No general host environment is inherited. On macOS, CoreFoundation may itself add `__CF_USER_TEXT_ENCODING` inside the child; the launcher does not pass it.

### Shared provider credentials

OAuth providers such as `openai-codex` store credentials in Pi's `auth.json`, not a provider environment variable. A person can explicitly approve the host auth file and, optionally, model definitions in the execution profile:

```typescript
{
  executable: '/absolute/path/to/node',
  sdkModule: '/absolute/path/to/@earendil-works/pi-coding-agent/dist/index.js',
  agentFiles: {
    auth: '/absolute/host/home/.pi/agent/auth.json',
    models: '/absolute/host/home/.pi/agent/models.json',
  },
  passEnvironment: [],
}
```

`agentFiles` accepts only `auth` and `models`, both existing regular files resolved to canonical paths before launch. Neither is copied or linked into the private home. The private SDK entrypoint passes those canonical paths to Pi's `ModelRuntime`, so OAuth refresh reads, writes and locks the same host file. The installed Pi 1.5.0 `FileAuthStorageBackend` uses `writeFileSync` in place, not rename, but `proper-lockfile` uses `realpath:false`: a symbolic link would share data while creating a different lock and could race host refresh. Direct canonical paths avoid both copied refresh tokens and separate locks, and keep working if the host replaces the file at that path. This SDK route is tested against Pi 1.5.0; requalify changes to its APIs or auth storage semantics.

The SDK entrypoint uses in-memory retry-disabled settings and an explicit empty resource loader. It never loads host/project settings, extensions, skills, themes, prompt templates, AGENTS.md or system prompt files. The standard Pi system prompt and the four configured coding tools remain. Approved `models.json` is trusted configuration: it can select provider endpoints, headers and command-based credential resolution. Sharing `auth.json` gives the worker access to every credential in that file and permission to update them; the profile does not isolate one provider's credentials. The person must trust the worker with that access, including token refresh and any configured credential commands. No credential values enter prompts, references or evidence.

These are resource-loading controls, not an OS sandbox. Native coding tools remain available. A person who explicitly allows runtime configuration variables such as `NODE_OPTIONS` or `PI_CODING_AGENT_DIR` is trusting their effects, including changes to resource loading. Executables, the retained state root and execution profiles must remain person-controlled. The owning host, not the transport, enforces run deadlines and budget policy.

Activation consumes its one prompt attempt before writing. A timeout, malformed acknowledgement or lost reply stays uncertain, even if a turn ends afterwards. Concurrent/replayed activation cannot send twice. Turn events and idle preparation are separate from observed direct-child exit. Stop/fence use bounded TERM/KILL and confirm only after the child exit event; neither a signal request nor pipe EOF proves termination. No claim is made about descendants. A new adapter owner cannot adopt a PID or infer absence: references it does not own are unknown. It never restarts a worker.

Usage reads cumulative `get_session_stats`, not per-turn deltas. Missing/invalid values and failed reads are unknown; an explicit unsupported-command reply is unsupported. Regressing counters refuse reporting. The latest reported snapshot remains available after exit. Result transport returns only the binding's frozen `resultPath` (`<stateDirectory>/attempts/<attemptId>/result.json`) as a bounded, single-link regular-file path in retained storage; questions and artefacts directories sit beside that file, not in the launcher's private process directory; the core must open and validate the result, its identity and retention before completion or acceptance. The prompt carries worker protocol version 1 as JSON, including the exact allocation, instructions, ordered criteria, delivery contract and result/question paths.

The implementation consulted the **Pi** reference entry pinned at Switchboard `4077c10009c0ea895e990753d831a20e2fefaf15`: `rpc-client.ts`, `jsonl.ts` and `worker.ts`. It also checked the installed Pi CLI and RPC command documentation. Synthetic peers exercise the process boundary by default. Set `DOCKET_TEST_REAL_PI=1`, `DOCKET_TEST_PI_EXECUTABLE` (absolute), `DOCKET_TEST_PI_PROVIDER` and `DOCKET_TEST_PI_MODEL` to enable the optional real-Pi preparation/readiness/fencing probe. For shared OAuth auth, set the executable to Node and supply `DOCKET_TEST_PI_SDK_MODULE`, `DOCKET_TEST_PI_AUTH_FILE` and optionally `DOCKET_TEST_PI_MODELS_FILE` (all absolute). For environment credentials, explicitly name `DOCKET_TEST_PI_CREDENTIAL_VARIABLE`. The probe requires Pi's `get_available_models` to include the configured provider/model. It sends no prompt or model request and is not real-dispatch release qualification.
## Check policy and commands

`GitRepository.readCheckPolicy` resolves a full trusted target ref to an exact commit and reads `.docket/checks.json` from that tree, without checking it out. Confirmed absence permits context-only checks; an unreadable target, non-regular policy or malformed JSON refuses. The result records presence, source commit, source SHA-256 and effective policy digest. Context checks add requirements and duplicate names refuse.

`checkCommandRunner` is the check-specific process adapter. It runs one argument array with bounded timeout, no shell and ignored stdin, using only the supplied execution-profile environment after removing `DOCKET_` variables. Diagnostics are bounded and redacted. Timeout is failed, spawn failure is not run, and an unexpected signal or pipes left open by descendants is uncertain, never passed. On timeout it stops the check's process tree: macOS and Linux use a separate process group with SIGTERM followed by SIGKILL after a short grace period; Windows uses `taskkill /T /F`. It waits for termination before returning, including when descendants have closed their output pipes. This does not prove that no worker processes remain.

This implementation consulted the **Processes** reference entry pinned at Switchboard `4077c10009c0ea895e990753d831a20e2fefaf15`: `command.ts`, `executables.ts` and `storage.ts`. The no-shell invocation, bounded pipe-drain and diagnostic redaction approach was checked against R15/R16. Docket retains uncertainty and slot ownership after an unexpected kill.

## Verification

`npm run check` and `npm test` include real temporary Git repositories and isolated real Treehouse pools. Treehouse must be installed; adapter tests are not silently skipped. The implementation uses `git for-each-ref` with exact-name matching so missing refs are distinct from lookup failures. Qualification here used Node 26.7.0, Git 2.53.0 and Treehouse 3.1.4 on macOS.

The implementation consulted the **Treehouse and Git** reference entry pinned at Switchboard `4077c10009c0ea895e990753d831a20e2fefaf15`: `treehouse.ts`, `retention.ts`, `integration.ts`, `output-branch.ts` and `starting-point.ts`. Docket's specification governs the contract; notably checked-out fast-forwards use a ref transaction rather than an unprotected read followed by merge.
