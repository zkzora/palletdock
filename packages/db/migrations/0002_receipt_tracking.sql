-- Receipt tracking lifecycle, kept separate from the transaction's own statuses.
--   active          the tracker still checks this hash (on next_check_at)
--   settled         included and buried under the configured confirmation depth; checks stop
--   history_pruned  the node no longer serves this receipt/block; the last snapshot is kept; checks stop
--   gave_up         stopped after a bounded number of failed checks, or no receipt within the pending window
-- Terminal states are only left through an explicit reconcile.
ALTER TABLE transactions
  ADD COLUMN tracking_status TEXT NOT NULL DEFAULT 'active'
    CHECK (tracking_status IN ('active','settled','history_pruned','gave_up')),
  ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_check_at TIMESTAMPTZ;

CREATE INDEX transactions_tracking_idx ON transactions(next_check_at) WHERE tracking_status = 'active' AND hash IS NOT NULL;

-- Structured facts behind an observation (block number/hash, depth, provenance), alongside the readable detail.
ALTER TABLE transaction_observations ADD COLUMN data JSONB;
