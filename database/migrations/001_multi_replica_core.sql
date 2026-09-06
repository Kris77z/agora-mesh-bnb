-- Agora Mesh multi-replica persistence. Amounts are integer base units and times
-- are timestamptz. Secret/session key material and complete payment signatures
-- are intentionally absent from this schema.

CREATE TABLE runs (
  mission_id uuid PRIMARY KEY,
  scope text NOT NULL,
  owner_id text NOT NULL,
  goal text NOT NULL,
  request_mode text NOT NULL CHECK (request_mode IN ('scripted', 'react', 'commander')),
  locale text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
  result jsonb,
  error jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR lease_owner IS NULL)
);

CREATE TABLE run_idempotency (
  scope text NOT NULL,
  key_hash char(64) NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  mission_id uuid NOT NULL UNIQUE REFERENCES runs(mission_id) ON DELETE RESTRICT,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, key_hash)
);

CREATE TABLE run_events (
  mission_id uuid NOT NULL REFERENCES runs(mission_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  PRIMARY KEY (mission_id, sequence)
);

CREATE INDEX runs_claimable_idx
  ON runs (status, lease_expires_at, created_at)
  WHERE status IN ('created', 'running');
CREATE INDEX run_events_replay_idx ON run_events (mission_id, sequence);

CREATE TABLE x402_purchases (
  purchase_id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES runs(mission_id) ON DELETE RESTRICT,
  service_id text NOT NULL,
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  asset_kind text NOT NULL CHECK (asset_kind IN ('native', 'erc20')),
  asset_address char(42),
  asset_symbol text NOT NULL,
  asset_decimals smallint NOT NULL CHECK (asset_decimals BETWEEN 0 AND 255),
  amount NUMERIC(78,0) NOT NULL CHECK (amount >= 0),
  recipient char(42) NOT NULL,
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN (
    'quoted', 'settlement_attempting', 'settlement_uncertain',
    'paid', 'execution_pending', 'completed', 'failed'
  )),
  request jsonb NOT NULL,
  requirement jsonb NOT NULL,
  selected_accept jsonb NOT NULL,
  payment_evidence jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (mission_id, service_id),
  UNIQUE (service_id, idempotency_key_hash),
  CHECK ((asset_kind = 'native' AND asset_address IS NULL) OR
         (asset_kind = 'erc20' AND asset_address ~ '^0x[0-9A-Fa-f]{40}$')),
  CHECK (recipient ~ '^0x[0-9A-Fa-f]{40}$')
);

CREATE TABLE x402_executions (
  execution_id uuid PRIMARY KEY,
  service_id text NOT NULL,
  idempotency_key_hash char(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  purchase_id uuid UNIQUE REFERENCES x402_purchases(purchase_id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'settlement_attempting' CHECK (state IN (
    'settlement_attempting', 'settlement_uncertain', 'paid',
    'execution_pending', 'completed', 'failed'
  )),
  request jsonb NOT NULL,
  payment_evidence jsonb,
  response jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (service_id, idempotency_key_hash)
);

CREATE TABLE chain_transactions (
  transaction_id uuid PRIMARY KEY,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  tx_hash char(66) NOT NULL CHECK (tx_hash ~ '^0x[0-9A-Fa-f]{64}$'),
  purpose text NOT NULL,
  from_address char(42),
  to_address char(42),
  asset_address char(42),
  amount NUMERIC(78,0) CHECK (amount >= 0),
  calldata_hash char(66),
  block_number NUMERIC(78,0),
  block_hash char(66),
  status text NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed', 'reorged')),
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  UNIQUE (chain_id, tx_hash)
);

CREATE TABLE authorities (
  authority_id text PRIMARY KEY,
  wallet_address char(42) NOT NULL CHECK (wallet_address ~ '^0x[0-9A-Fa-f]{40}$'),
  session_public_key text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  allowed_calls jsonb NOT NULL,
  spend_limits jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'invalid')),
  encrypted_material_ref text,
  grant_transaction_id uuid REFERENCES chain_transactions(transaction_id) ON DELETE RESTRICT,
  revoke_transaction_id uuid REFERENCES chain_transactions(transaction_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (encrypted_material_ref IS NULL OR encrypted_material_ref !~ '^0x[0-9A-Fa-f]{64}$')
);

CREATE TABLE authority_steps (
  authority_id text NOT NULL REFERENCES authorities(authority_id) ON DELETE RESTRICT,
  step text NOT NULL CHECK (step IN (
    'grantSession', 'approveChecker', 'approveAllowance',
    'revokeChecker', 'revokeAllowance', 'revokeSession'
  )),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  state text NOT NULL CHECK (state IN ('pending', 'broadcast', 'confirmed', 'failed', 'uncertain')),
  transaction_id uuid REFERENCES chain_transactions(transaction_id) ON DELETE RESTRICT,
  public_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (authority_id, step, attempt)
);

CREATE TABLE service_leases (
  service_id text PRIMARY KEY,
  agent_id text NOT NULL,
  endpoint text NOT NULL,
  capability jsonb NOT NULL,
  runtime_available boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX service_leases_active_idx
  ON service_leases (expires_at, runtime_available)
  WHERE runtime_available = true;

CREATE TABLE service_feedback (
  feedback_id uuid PRIMARY KEY,
  service_id text NOT NULL,
  agent_id text NOT NULL,
  mission_id uuid REFERENCES runs(mission_id) ON DELETE RESTRICT,
  value smallint NOT NULL CHECK (value BETWEEN 0 AND 100),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((locked_by IS NULL) = (locked_until IS NULL))
);

CREATE INDEX outbox_pending_idx
  ON outbox (available_at, id)
  WHERE published_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    GRANT USAGE ON SCHEMA public TO agora_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agora_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agora_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agora_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO agora_runtime;
  END IF;
END
$$;
