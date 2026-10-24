-- Indexer coverage and worker bookkeeping.
--
-- A coverage row records that [from_block, to_block] was scanned for the
-- source's filter and every matching log was committed, including ranges that
-- returned no logs. Rows are written in the same transaction as the logs and
-- the checkpoint, and are trimmed when a reorg rolls the checkpoint back.

CREATE TABLE indexer_coverage (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID NOT NULL REFERENCES indexer_sources(id),
  from_block    BIGINT NOT NULL,
  to_block      BIGINT NOT NULL,
  to_block_hash TEXT NOT NULL,
  log_count     INTEGER NOT NULL,
  generation    BIGINT NOT NULL,
  reorg_epoch   BIGINT NOT NULL,
  lease_token   UUID NOT NULL,
  committed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_block >= from_block),
  CHECK (log_count >= 0)
);
CREATE INDEX indexer_coverage_source ON indexer_coverage(source_id, from_block);

-- Rollback bookkeeping: how far back the last reorg rewound and why.
ALTER TABLE indexer_sources
  ADD COLUMN last_reorg_at        TIMESTAMPTZ,
  ADD COLUMN last_reorg_from      BIGINT,
  ADD COLUMN last_reorg_ancestor  BIGINT;

ALTER TABLE indexer_jobs
  ADD COLUMN last_success_at TIMESTAMPTZ;

CREATE INDEX indexer_jobs_due ON indexer_jobs(next_run_at);
CREATE INDEX raw_logs_source_block ON raw_logs(source_id, block_number) WHERE canonical;
