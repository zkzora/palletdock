-- PalletDock initial schema.
-- Chain quantities: block numbers are BIGINT (returned as strings by node-pg);
-- amounts/gas are NUMERIC(78,0) (exact, up to uint256). Never cast through float.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- owners
CREATE TABLE owners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_token    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT
);
CREATE INDEX sessions_owner_idx ON sessions(owner_id);

CREATE TABLE login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  success    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts(email, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts(ip_hash, created_at DESC);

-- ---------------------------------------------------------------- network identity
-- One row per observed network identity. Exactly one may be 'active' per
-- network_id. A changed genesis creates a 'mismatch' row and requires an
-- explicit operator migration (see docs/NETWORK.md); it is never accepted silently.
CREATE TABLE network_fingerprints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','mismatch','superseded')),
  genesis_hash       TEXT NOT NULL,
  evm_chain_id       BIGINT NOT NULL,
  evm_genesis_hash   TEXT,
  spec_name          TEXT,
  spec_version       BIGINT,
  ss58_format        INTEGER,
  token_symbol       TEXT,
  token_decimals     INTEGER,
  evidence           JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at      TIMESTAMPTZ,
  UNIQUE (network_id, genesis_hash, evm_chain_id)
);
CREATE UNIQUE INDEX network_fingerprints_one_active ON network_fingerprints(network_id) WHERE status = 'active';

CREATE TABLE rpc_probes (
  id              BIGSERIAL PRIMARY KEY,
  network_id      TEXT NOT NULL,
  fingerprint_id  UUID REFERENCES network_fingerprints(id),
  target          TEXT NOT NULL CHECK (target IN ('evm','substrate')),
  method          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('responded','failed','unavailable')),
  latency_ms      INTEGER,
  result          JSONB,
  error           TEXT,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rpc_probes_time_idx ON rpc_probes(network_id, observed_at DESC);

CREATE TABLE account_mappings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_id   UUID NOT NULL REFERENCES network_fingerprints(id),
  direction        TEXT NOT NULL CHECK (direction IN ('evm_to_native')),
  evm_address      TEXT NOT NULL,
  native_account_hex TEXT NOT NULL,
  native_ss58      TEXT NOT NULL,
  method           TEXT NOT NULL,
  block_number     BIGINT,
  block_hash       TEXT NOT NULL,
  spec_version     BIGINT NOT NULL,
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at   TIMESTAMPTZ
);
CREATE INDEX account_mappings_lookup ON account_mappings(fingerprint_id, lower(evm_address), resolved_at DESC);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES owners(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  network_id   TEXT NOT NULL,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_owner_name ON projects(owner_id, lower(name));

-- ---------------------------------------------------------------- contracts
CREATE TABLE artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id),
  name               TEXT NOT NULL,
  contract_name      TEXT,
  abi                JSONB NOT NULL,
  creation_bytecode  TEXT NOT NULL,
  deployed_bytecode  TEXT,
  bytecode_kind      TEXT NOT NULL CHECK (bytecode_kind IN ('evm','polkavm')),
  compiler           JSONB,
  checksum_sha256    TEXT NOT NULL,
  provenance         TEXT NOT NULL CHECK (provenance IN ('bundled-sample','uploaded')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, checksum_sha256)
);

CREATE TABLE contracts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id),
  fingerprint_id   UUID NOT NULL REFERENCES network_fingerprints(id),
  name             TEXT NOT NULL,
  address          TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('deployed','imported')),
  artifact_id      UUID REFERENCES artifacts(id),
  deploy_tx_hash   TEXT,
  deploy_block     BIGINT,
  code_observed    JSONB,
  removed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contracts_tracked_unique ON contracts(project_id, fingerprint_id, lower(address)) WHERE removed_at IS NULL;

CREATE TABLE abi_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  UUID NOT NULL REFERENCES contracts(id),
  version      INTEGER NOT NULL,
  abi          JSONB NOT NULL,
  abi_sha256   TEXT NOT NULL,
  provenance   TEXT NOT NULL CHECK (provenance IN ('artifact','import','replacement')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, version)
);

-- ---------------------------------------------------------------- transactions
CREATE TABLE transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id),
  fingerprint_id     UUID NOT NULL REFERENCES network_fingerprints(id),
  contract_id        UUID REFERENCES contracts(id),
  abi_version_id     UUID REFERENCES abi_versions(id),
  artifact_id        UUID REFERENCES artifacts(id),
  origin             TEXT NOT NULL CHECK (origin IN ('palletdock','registered')),
  kind               TEXT NOT NULL CHECK (kind IN ('deploy','call','unknown')),
  hash               TEXT,
  from_address       TEXT,
  to_address         TEXT,
  input              TEXT,
  value_raw          NUMERIC(78,0),
  nonce              NUMERIC(78,0),
  function_name      TEXT,
  decoded_args       JSONB,
  submission_status  TEXT NOT NULL CHECK (submission_status IN ('prepared','rejected','submitted','unknown')),
  inclusion_status   TEXT NOT NULL DEFAULT 'not_observed' CHECK (inclusion_status IN ('not_observed','pending','included','reorged_out')),
  execution_status   TEXT NOT NULL DEFAULT 'unknown' CHECK (execution_status IN ('unknown','success','reverted')),
  finality_status    TEXT NOT NULL DEFAULT 'unknown' CHECK (finality_status IN ('unknown')),
  indexing_status    TEXT NOT NULL DEFAULT 'not_applicable' CHECK (indexing_status IN ('not_applicable','not_covered','pending','indexed','no_events')),
  block_number       BIGINT,
  block_hash         TEXT,
  tx_index           INTEGER,
  gas_used           NUMERIC(78,0),
  effective_gas_price NUMERIC(78,0),
  fee_raw            NUMERIC(78,0),
  contract_address   TEXT,
  receipt            JSONB,
  revert_data        TEXT,
  revert_decoded     JSONB,
  storage_deposit    JSONB,
  estimates          JSONB,
  error_message      TEXT,
  last_checked_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transactions_hash_unique ON transactions(project_id, fingerprint_id, lower(hash)) WHERE hash IS NOT NULL;
CREATE INDEX transactions_project_idx ON transactions(project_id, created_at DESC, id DESC);
CREATE INDEX transactions_pending_idx ON transactions(inclusion_status) WHERE hash IS NOT NULL AND inclusion_status IN ('not_observed','pending');

-- Observed lifecycle stages. Only what PalletDock actually observed, with
-- the observation time (not a fabricated chain timestamp).
CREATE TABLE transaction_observations (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  stage           TEXT NOT NULL,
  detail          TEXT,
  source          TEXT NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transaction_observations_tx ON transaction_observations(transaction_id, id);

-- ---------------------------------------------------------------- indexer
CREATE TABLE indexer_sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id),
  contract_id       UUID NOT NULL REFERENCES contracts(id),
  fingerprint_id    UUID NOT NULL REFERENCES network_fingerprints(id),
  abi_version_id    UUID NOT NULL REFERENCES abi_versions(id),
  contract_address  TEXT NOT NULL,
  event_names       TEXT[] NOT NULL,
  event_topics      TEXT[] NOT NULL,
  start_block       BIGINT NOT NULL,
  end_block         BIGINT,
  finality_policy   TEXT NOT NULL DEFAULT 'included-with-explicit-finality',
  inclusion_policy  TEXT NOT NULL DEFAULT 'canonical-observed-head',
  desired_state     TEXT NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running','paused','archived','deleted')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','backfilling','following','completed','paused','error','recovery_required','stopped')),
  generation        BIGINT NOT NULL DEFAULT 1,
  reorg_epoch       BIGINT NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_error_at     TIMESTAMPTZ,
  latest_observed_block BIGINT,
  latest_observed_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_block IS NULL OR end_block >= start_block)
);
CREATE INDEX indexer_sources_project ON indexer_sources(project_id);

-- Lease/fencing: a worker may commit only while it holds the lease with the
-- same lease_token and the source generation it read at claim time.
CREATE TABLE indexer_jobs (
  source_id         UUID PRIMARY KEY REFERENCES indexer_sources(id),
  lease_owner       TEXT,
  lease_token       UUID,
  lease_expires_at  TIMESTAMPTZ,
  lease_generation  BIGINT,
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts          INTEGER NOT NULL DEFAULT 0,
  chunk_size        INTEGER NOT NULL DEFAULT 500,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indexer_checkpoints (
  source_id      UUID PRIMARY KEY REFERENCES indexer_sources(id),
  block_number   BIGINT NOT NULL,
  block_hash     TEXT NOT NULL,
  committed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Headers observed per source range (retained ancestry for reorg detection).
CREATE TABLE block_headers (
  fingerprint_id  UUID NOT NULL REFERENCES network_fingerprints(id),
  source_id       UUID NOT NULL REFERENCES indexer_sources(id),
  block_number    BIGINT NOT NULL,
  block_hash      TEXT NOT NULL,
  parent_hash     TEXT NOT NULL,
  block_timestamp BIGINT,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, block_number)
);

CREATE TABLE raw_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               BIGSERIAL UNIQUE,
  source_id         UUID NOT NULL REFERENCES indexer_sources(id),
  project_id        UUID NOT NULL REFERENCES projects(id),
  fingerprint_id    UUID NOT NULL REFERENCES network_fingerprints(id),
  contract_address  TEXT NOT NULL,
  block_number      BIGINT NOT NULL,
  block_hash        TEXT NOT NULL,
  transaction_hash  TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  log_index         INTEGER NOT NULL,
  topics            TEXT[] NOT NULL,
  data              TEXT NOT NULL,
  canonical         BOOLEAN NOT NULL DEFAULT true,
  orphaned_at       TIMESTAMPTZ,
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, fingerprint_id, block_hash, transaction_hash, log_index)
);
CREATE INDEX raw_logs_query ON raw_logs(project_id, canonical, block_number, transaction_index, log_index);
CREATE INDEX raw_logs_tx ON raw_logs(project_id, lower(transaction_hash));

CREATE TABLE decoded_events (
  raw_log_id      UUID PRIMARY KEY REFERENCES raw_logs(id),
  abi_version_id  UUID REFERENCES abi_versions(id),
  status          TEXT NOT NULL CHECK (status IN ('decoded','unknown_event','decode_error')),
  event_name      TEXT,
  event_signature TEXT,
  args            JSONB,
  decode_error    TEXT,
  decoded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- API
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL UNIQUE,
  secret_hash   TEXT NOT NULL,
  scopes        TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  replaced_by   UUID REFERENCES api_keys(id)
);
CREATE INDEX api_keys_project ON api_keys(project_id);

CREATE TABLE request_logs (
  id           BIGSERIAL PRIMARY KEY,
  request_id   TEXT NOT NULL,
  project_id   UUID REFERENCES projects(id),
  api_key_id   UUID REFERENCES api_keys(id),
  auth_kind    TEXT NOT NULL CHECK (auth_kind IN ('api_key','session','none')),
  method       TEXT NOT NULL,
  route        TEXT NOT NULL,
  status       INTEGER NOT NULL,
  error_code   TEXT,
  latency_ms   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX request_logs_project_time ON request_logs(project_id, created_at DESC);

-- ---------------------------------------------------------------- operations
CREATE TABLE ops_logs (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID REFERENCES projects(id),
  source          TEXT NOT NULL CHECK (source IN ('indexer','rpc','api','worker','transaction','network')),
  level           TEXT NOT NULL CHECK (level IN ('INFO','WARN','ERROR')),
  message         TEXT NOT NULL,
  detail          JSONB,
  indexer_source_id UUID REFERENCES indexer_sources(id),
  transaction_id  UUID REFERENCES transactions(id),
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ops_logs_time ON ops_logs(created_at DESC);
CREATE INDEX ops_logs_project_time ON ops_logs(project_id, created_at DESC);

CREATE TABLE worker_heartbeats (
  worker_id     TEXT PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  info          JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Worker control requests (e.g. reconnect) issued from the workspace.
CREATE TABLE worker_commands (
  id          BIGSERIAL PRIMARY KEY,
  source_id   UUID REFERENCES indexer_sources(id),
  command     TEXT NOT NULL CHECK (command IN ('reconnect','simulate_rpc_failure')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
