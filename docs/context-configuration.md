# Context configuration and initialisation

Use configuration format 1 from the [configuration contract](specification/contracts.md#configuration). Every shown field must be present, including explicit nulls; unknown fields refuse. The parser does not expand `~`, interpolate environment variables or supply missing policy fields. Credentials belong in host credential facilities, not this file.

Write absolute, normalised paths without symbolic links. Missing state/database/pool paths are allowed if their existing ancestors are canonical. `configurationPaths(contextId, home)` in `src/configuration.ts` supplies the conventional paths when constructing a file:

- state directory: `<home>/.docket/<contextId>`
- database: `<stateDirectory>/docket.db`
- workspace pool: `<stateDirectory>/pool`

The database must be outside the pool; an explicit database path may be separate from the state directory. The pool may be below the state directory, as it is by default. Explicit paths are honoured. State directories, databases and pools cannot overlap another registered context's storage.

When preparing a new file, the specified initial defaults are `maxAttempts=1`, `maxAttemptsPerTask=3`, `maxConcurrentFullChecks=1`, manual finalisation, `runMs=1800000` and `keepAwake=true`. Write these values explicitly, along with person-selected repository, provider, model and execution profiles. There is no interactive wizard in this implementation.

Counts and timeouts accept integers from 1 to 2147483647. Token budgets accept 0 to `Number.MAX_SAFE_INTEGER`, or null. Cost budgets accept finite nonnegative numbers, or null. Profiles must be nonempty and all default/kind profile references must exist. Check names are unique across context fast/full additions. Resolving repository check policy and host execution-profile options belongs to the later check/adapter operations, not initialisation.

`parseConfiguration` produces a SHA-256 digest of the validated, non-secret JSON, sorting every object's keys. Whitespace and object key order do not affect it; array order does. Duplicate JSON members refuse, including escaped spellings of the same name. Null `finalisation.globalFile` remains the contract's conventional-policy sentinel, not a request to disable policy.

## Initialise

```sh
node bin/docket.ts context init --config /absolute/path/to/docket.json --json
```

Arguments are `{}`; an explicit input file or stdin may supply that empty object. Initialisation records a generated database UUID, canonical repository path and configuration (resolved values, digest, revision 1 and source file) in the database's genesis transaction. It creates an empty workspace pool and adds the name-to-file entry to `~/.config/docket/contexts.json`. The registry is a JSON object, for example:

```json
{ "my-project": "/absolute/path/to/docket.json" }
```

Names already registered and nonempty databases refuse without changing either file. Existing nonempty pools refuse rather than adopting or cleaning up retained allocations. Initialisation does not invoke Git, Treehouse, a launcher, a host or a plugin. It does not authorise execution or perform the later activation smoke workflow.

`--context my-project` resolves the registered configuration file instead of `--config`. Exactly one selector is required for context operations. A new name must first be initialised through `--config`; selecting an already registered name for init refuses.

## Admission for later operations

`openContext(selector, options)` in `src/context.ts` resolves either selector, validates the file and compares its digest and revision against the latest `context.configured` event before returning the database. Mismatches give `config_changed` with `recordedDigest`, `currentDigest`, `recordedRevision` and `currentRevision`. File changes are not silently applied. This implementation establishes revision 1; `context.configure` is not implemented. A trusted host can pin `expectedRevision` explicitly.

The returned database defaults to read-only. Close it with `using database = context.database` or in `finally`. The lower-level storage API remains available for storage tests and internal operations; application entry points must use context admission rather than bypassing it.

Like the storage opener, context APIs take a trusted `recyclableRoots` inventory. Hosts must supply the complete inventory; task input and configuration cannot override it. All three storage paths are checked before directory creation. An empty inventory only establishes that no roots were supplied, not that arbitrary external storage is retained. The ordinary CLI additionally checks the registered contexts' storage for collisions, but has no adapter discovery of unregistered workspace roots yet. Filesystem locality and protection against concurrent untrusted directory replacement have the same host preconditions as the [storage opener](../src/storage/README.md#opening).

## Interrupted initialisation

A per-user exclusive registry lock serialises initialisers across names. It records PID, context name and configuration file. A competing initialiser refuses with `storage_busy`; it never removes another owner's lock. If a process dies, inspect its owner and state before a person removes a stale lock.

The registry replacement is prepared and flushed before the database commits, then published by rename. SQLite and a filesystem rename cannot commit together. A crash or failed rename after the database commit can therefore leave a valid, unregistered database. Do not delete or reinitialise it. Preserve the database, source configuration and any registry temporary file; inspect `database.initialised` and `context.configured` using the read-only storage API, verify UUID/name/paths/digest and the absence of conflicting registration, then repair the name-to-file registry entry explicitly. A reported publication failure includes the database path, UUID and configuration file. A retry refuses the nonempty database rather than replacing it. Temporary files and locks from a live invocation are cleaned up when it exits normally.

Configuration edits after initialisation currently require restoring the recorded file; the explicit quiescent configure operation is a separate task. No initialisation recovery step returns a lease, deletes a branch, starts a worker or installs a plugin.
