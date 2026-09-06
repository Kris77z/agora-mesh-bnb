-- Runtime adapters need a durable mission projection and the complete public
-- Authority lifecycle envelope. Secret material remains outside PostgreSQL.

CREATE TABLE missions (
  mission_id uuid PRIMARY KEY,
  goal text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  authority_id text,
  mode text NOT NULL CHECK (mode IN ('scripted', 'react', 'commander')),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  source text NOT NULL CHECK (source IN ('live-run', 'recovered-evidence')),
  events jsonb NOT NULL,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX missions_completed_idx ON missions (completed_at DESC, mission_id);

ALTER TABLE authorities
  ADD COLUMN lifecycle jsonb,
  ADD COLUMN revocation jsonb;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON missions TO agora_runtime;
  END IF;
END
$$;
