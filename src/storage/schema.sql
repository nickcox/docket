-- Docket starting schema, SQL schema version 1.
-- Execute on a verified empty file inside the initialisation transaction.
-- Connection durability pragmas and BEGIN IMMEDIATE belong to the opener.
PRAGMA application_id = 1145787441; -- 0x444B5431, DKT1: database family

CREATE TABLE objectives (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  request TEXT NOT NULL CHECK (length(trim(request)) > 0),
  criteria TEXT NOT NULL CHECK (json_valid(criteria) AND json_type(criteria) = 'array'),
  scope TEXT NOT NULL,
  constraints_text TEXT NOT NULL,
  permissions TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'object'),
  budget TEXT NOT NULL CHECK (json_valid(budget) AND json_type(budget) = 'object'),
  deadline TEXT,
  creator TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','completed','abandoned')),
  first_supervised_seq INTEGER,
  handled_seq INTEGER NOT NULL DEFAULT 0 CHECK (handled_seq >= 0),
  completion TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completion) AND json_type(completion) = 'array'),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  instructions TEXT NOT NULL,
  criteria TEXT NOT NULL CHECK (json_valid(criteria) AND json_type(criteria) = 'array'),
  kind TEXT NOT NULL CHECK (kind IN ('code','report','review')),
  profile TEXT,
  objective_id TEXT REFERENCES objectives(id),
  position INTEGER NOT NULL UNIQUE CHECK (position > 0),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','in_flight','done')),
  hold_reason TEXT CHECK (hold_reason IS NULL OR
    (length(trim(hold_reason)) BETWEEN 1 AND 200 AND instr(hold_reason,char(10)) = 0 AND instr(hold_reason,char(13)) = 0)),
  definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision > 0),
  decision_revision INTEGER NOT NULL DEFAULT 0 CHECK (decision_revision >= 0),
  review_target TEXT CHECK (review_target IS NULL OR (json_valid(review_target) AND json_type(review_target) = 'object')),
  review_source_attempt_id TEXT REFERENCES attempts(id),
  CHECK ((review_target IS NULL) = (review_source_attempt_id IS NULL)),
  CHECK (kind = 'review' OR review_target IS NULL)
);

CREATE TABLE dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  blocker_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, blocker_id),
  CHECK (task_id <> blocker_id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  number INTEGER NOT NULL CHECK (number > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  execution_open INTEGER NOT NULL DEFAULT 1 CHECK (execution_open IN (0,1)),
  phase TEXT NOT NULL CHECK (phase IN ('reserved','allocated','running','awaiting_checks','settled','needs_resolution')),
  launch_state TEXT NOT NULL DEFAULT 'pending' CHECK (launch_state IN ('pending','permitted','fenced')),
  specification TEXT NOT NULL CHECK (json_valid(specification) AND json_type(specification) = 'object'),
  started_decision_revision INTEGER,
  objective_id TEXT REFERENCES objectives(id),
  source_attempt_id TEXT REFERENCES attempts(id),
  output_ref TEXT NOT NULL UNIQUE,
  lease_id TEXT UNIQUE,
  allocation TEXT CHECK (allocation IS NULL OR (json_valid(allocation) AND json_type(allocation) = 'object')),
  runtime_ref TEXT CHECK (runtime_ref IS NULL OR (json_valid(runtime_ref) AND json_type(runtime_ref) = 'object')),
  owner_claim_id TEXT REFERENCES claims(id),
  candidate TEXT CHECK (candidate IS NULL OR (json_valid(candidate) AND json_type(candidate) = 'object')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','held','failed','interrupted','over_budget')),
  lease_state TEXT NOT NULL DEFAULT 'none' CHECK (lease_state IN ('none','held','returned','unknown')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (task_id, number),
  CHECK ((lease_id IS NULL) = (allocation IS NULL)),
  CHECK (allocation IS NULL OR (json_extract(allocation,'$.leaseId') IS NOT NULL AND json_extract(allocation,'$.leaseId') = lease_id)),
  CHECK (launch_state <> 'permitted' OR (runtime_ref IS NOT NULL AND owner_claim_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_attempt_per_task ON attempts(task_id) WHERE execution_open = 1;
CREATE INDEX attempts_by_objective ON attempts(objective_id, created_at);

CREATE TABLE claims (
  id TEXT PRIMARY KEY NOT NULL,
  resource_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('worker_owner','supervisor','check_executor','maintenance')),
  attempt_id TEXT REFERENCES attempts(id),
  objective_id TEXT REFERENCES objectives(id),
  generation TEXT NOT NULL,
  owner_ref TEXT NOT NULL CHECK (json_valid(owner_ref) AND json_type(owner_ref) = 'object'),
  schema_family INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT CHECK (release_evidence IS NULL OR json_valid(release_evidence)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((released_at IS NULL) = (release_evidence IS NULL))
);
CREATE UNIQUE INDEX one_unreleased_claim_per_resource ON claims(resource_key) WHERE released_at IS NULL;

CREATE TABLE requests (
  id TEXT PRIMARY KEY NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('command','effect')),
  operation TEXT NOT NULL,
  parent_id TEXT REFERENCES requests(id),
  attempt_id TEXT REFERENCES attempts(id),
  objective_id TEXT REFERENCES objectives(id),
  caller TEXT NOT NULL CHECK (json_valid(caller) AND json_type(caller) = 'object'),
  fingerprint TEXT NOT NULL,
  input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','succeeded','rejected','withdrawn','uncertain')),
  claim_id TEXT REFERENCES claims(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  result TEXT CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
  CHECK (category <> 'effect' OR state NOT IN ('claimed','uncertain') OR claim_id IS NOT NULL),
  CHECK (state NOT IN ('succeeded','rejected','withdrawn') OR result IS NOT NULL)
);
CREATE INDEX requests_pending ON requests(state, operation, created_at);
CREATE INDEX requests_for_attempt ON requests(attempt_id, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  objective_id TEXT REFERENCES objectives(id),
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  request_id TEXT REFERENCES requests(id),
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (json_valid(actor) AND json_type(actor) = 'object'),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  notification INTEGER NOT NULL DEFAULT 0 CHECK (notification IN (0,1)),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object')
);
CREATE INDEX events_for_objective ON events(objective_id, seq);
CREATE INDEX events_for_attempt ON events(attempt_id, seq);
CREATE INDEX events_by_correlation ON events(correlation_id, seq);
CREATE INDEX events_by_kind ON events(kind, seq);

PRAGMA user_version = 1;
