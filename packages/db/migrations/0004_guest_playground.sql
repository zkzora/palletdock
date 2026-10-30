-- Temporary playground workspaces.
-- A guest is an owner row with kind='guest': no email, no password hash, and a
-- fixed expiry. It reuses the owner/session/project ownership model; the
-- session token is random and only its hash is stored (sessions.token_hash).
-- Guests can never match password login, signup duplicate checks, or the
-- owner bootstrap CLI, because those select by email.
ALTER TABLE owners
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account','guest')),
  ADD COLUMN guest_expires_at TIMESTAMPTZ,
  -- Mutating / RPC-backed workspace requests used by this guest (bounded by configuration).
  ADD COLUMN guest_actions INTEGER NOT NULL DEFAULT 0,
  -- Set by the expiry maintenance pass once sessions, keys and indexer sources were shut down.
  ADD COLUMN guest_closed_at TIMESTAMPTZ,
  -- Set when a guest was converted into a normal account through registration.
  ADD COLUMN promoted_at TIMESTAMPTZ;

ALTER TABLE owners ALTER COLUMN email DROP NOT NULL;
ALTER TABLE owners ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE owners ADD CONSTRAINT owners_kind_credentials CHECK (
  (kind = 'account' AND email IS NOT NULL AND password_hash IS NOT NULL AND guest_expires_at IS NULL)
  OR (kind = 'guest' AND email IS NULL AND password_hash IS NULL AND guest_expires_at IS NOT NULL)
);
CREATE INDEX owners_guest_expiry_idx ON owners(guest_expires_at) WHERE kind = 'guest';

-- Persistent guest-creation throttling per visitor address hash (survives restarts
-- and replicas, and is not reset when a guest is later saved as an account).
CREATE TABLE guest_starts (
  id          BIGSERIAL PRIMARY KEY,
  ip_hash     TEXT NOT NULL,
  owner_id    UUID REFERENCES owners(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guest_starts_ip_idx ON guest_starts(ip_hash, created_at DESC);

-- Guided playground state for a project. Progress holds only non-sensitive,
-- server-observed facts (for example a successful eth_call); everything else
-- in the checklist is derived from existing records.
ALTER TABLE projects
  ADD COLUMN playground BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN playground_template TEXT CHECK (playground_template IN ('storage','erc20','erc721','payments')),
  ADD COLUMN playground_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
