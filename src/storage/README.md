# SQLite storage

`database.ts` owns `node:sqlite`, connection settings and write locks. `schema.sql` is the starting schema, copied unchanged from the normative specification; the schema test compares both the text and the resulting tables/indexes. There are seven application tables and no triggers.

## Opening

- `Database.initialise(path, initial, options)` deliberately creates an absent or zero-length regular file. It records a generated database UUID and the supplied resolved configuration in the same transaction as the schema. It never adopts a nonempty file.
- `Database.open(path, options)` defaults to read-only. Missing databases give `not_initialised`. It checks family and version using a read-only connection before any persistent pragmas or exclusive-creation probe. Unsupported families/versions are not migrated or rewritten. Version 1 has no preceding supported schema to migrate.
- A writable open uses `{ ...options, readOnly: false }`. All write methods recheck family/version under `BEGIN IMMEDIATE`. Future migrations and domain operations must extend admission checks here, not bypass them with another connection owner.
- Use `using database = await Database.open(...)`, or close it in `finally`. Failed opens and failed initialisations close their connections. Transaction failures roll back before returning; the connection remains usable.

The trusted host supplies `options.location`: an existing canonical `retainedRoot` on local storage and the complete inventory of `recyclableRoots`. The database must be below the retained root and outside every recyclable root. Neither workers nor task text may choose this policy. Parents must already exist. Paths must be absolute, canonical and free of symbolic links; database hard links and non-regular files are refused. The opener checks exclusive creation on writable paths and refuses known network filesystem types. Other filesystems' locality is a host precondition: there is no portable API that proves a filesystem is retained, local or durably backed. Directory ownership must prevent concurrent untrusted path replacement; `node:sqlite` opens a pathname, not an already-verified file descriptor.

Read-only opens do not create directories, database files or probe files. They do not change journal mode; a recognised database not in WAL mode needs a writable open first. SQLite may manage its normal WAL/shared-memory sidecars. A live WAL database must be backed up with SQLite's backup API or checkpointed and closed, not copied as a single file.

## Transactions and evidence

`appendEvents` is the initial narrow write operation. It inserts a batch atomically, generates event IDs, preserves recording order and compares duplicate source keys by logical JSON content. Conflicting duplicates or relational constraints refuse the whole batch. There is no event update/delete/replace method and no public raw SQL or transaction callback API. Domain-specific payload validation, authority and state transitions belong in typed operations as they are added; generic event storage does not grant authority or validate all future event families.

Transaction callbacks are internal and synchronous. They may only perform database work: never await filesystem operations, processes or providers while holding a lock. Busy admission retries yield to the event loop, with a finite deadline (default 5 seconds, configurable up to 60 seconds). SQLite's own busy timeout is zero. Callback failures roll back, including a defensive refusal of Promise/thenable returns. Open retries also use fresh connections for transient Windows `SQLITE_IOERR_TRUNCATE` failures after an unclean exit.

## Durability and qualification

Every connection requests foreign keys, synchronous FULL, fullfsync and checkpoint_fullfsync. Writable connections establish WAL; read-only ones require it. `settings()` exposes requested SQLite settings, not a proof of hardware durability. SQLite's full-fsync options have additional effect on macOS where supported; other OS/filesystem combinations can provide only their ordinary sync guarantees. Network filesystems are unsupported. Devices, virtualised storage and filesystems can still fail to honour sync requests. No stronger power-loss guarantee is claimed.

The default tests cover schema inspection, byte-preserving refusal, path admission, settings, bounded asynchronous contention, event rollback and a real child process killed inside a reservation transaction. The crash fixture alone reaches private transaction machinery for fault injection; it is not an application SQL interface. A second process reopens and commits after the kill, and the test checks for partial rows and database integrity. These tests were run locally on macOS; CI runs the same suite on macOS, Linux and Windows. Host/filesystem qualification and future migration protocols remain separate work.
