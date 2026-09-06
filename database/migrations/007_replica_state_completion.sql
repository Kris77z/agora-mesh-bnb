-- Remaining mutable backend state needed by stateless replicas. Static service
-- catalogs and experiment artifacts remain versioned, read-only files.

CREATE TABLE agent_identities (
  agent_id text PRIMARY KEY,
  identity jsonb NOT NULL,
  active boolean NOT NULL,
  registered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX agent_identities_active_idx
  ON agent_identities (active, updated_at DESC);

CREATE TABLE onchain_identities (
  identity_key text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('hunter', 'writer')),
  registry_address text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  wallet_address text NOT NULL,
  record jsonb NOT NULL,
  registered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE hunter_experiences (
  experience_id uuid PRIMARY KEY,
  content_hash char(64) NOT NULL UNIQUE CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  mission_id text NOT NULL,
  experience jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX hunter_experiences_recent_idx
  ON hunter_experiences (occurred_at DESC, experience_id DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO agora_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON onchain_identities TO agora_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON hunter_experiences TO agora_runtime;
  END IF;
END
$$;
