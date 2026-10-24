-- Self-service accounts keep the existing owner/project ownership model, but
-- enforce normalized email uniqueness and persist signup throttling across API
-- restarts and replicas.
UPDATE owners SET email = lower(trim(email));

CREATE UNIQUE INDEX owners_email_lower_unique ON owners(lower(email));

CREATE TABLE signup_attempts (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  success    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signup_attempts_email_idx ON signup_attempts(email, created_at DESC);
CREATE INDEX signup_attempts_ip_idx ON signup_attempts(ip_hash, created_at DESC);
