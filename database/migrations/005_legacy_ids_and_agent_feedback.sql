-- Historical acceptance runs and imported reputation samples use stable external
-- identifiers as well as UUIDs. Keep identifiers opaque across the persistence
-- boundary instead of rejecting otherwise valid history during cutover.

ALTER TABLE run_events DROP CONSTRAINT run_events_mission_id_fkey;
ALTER TABLE run_idempotency DROP CONSTRAINT run_idempotency_mission_id_fkey;
ALTER TABLE x402_purchases DROP CONSTRAINT x402_purchases_mission_id_fkey;
ALTER TABLE service_feedback DROP CONSTRAINT service_feedback_mission_id_fkey;

ALTER TABLE runs ALTER COLUMN mission_id TYPE text USING mission_id::text;
ALTER TABLE run_events ALTER COLUMN mission_id TYPE text USING mission_id::text;
ALTER TABLE run_idempotency ALTER COLUMN mission_id TYPE text USING mission_id::text;
ALTER TABLE x402_purchases ALTER COLUMN mission_id TYPE text USING mission_id::text;
ALTER TABLE service_feedback ALTER COLUMN mission_id TYPE text USING mission_id::text;
ALTER TABLE missions ALTER COLUMN mission_id TYPE text USING mission_id::text;

ALTER TABLE run_events
  ADD CONSTRAINT run_events_mission_id_fkey
  FOREIGN KEY (mission_id) REFERENCES runs(mission_id) ON DELETE CASCADE;
ALTER TABLE run_idempotency
  ADD CONSTRAINT run_idempotency_mission_id_fkey
  FOREIGN KEY (mission_id) REFERENCES runs(mission_id) ON DELETE RESTRICT;
ALTER TABLE x402_purchases
  ADD CONSTRAINT x402_purchases_mission_id_fkey
  FOREIGN KEY (mission_id) REFERENCES runs(mission_id) ON DELETE RESTRICT;

-- Service feedback can originate outside this Hunter deployment (including
-- imported benchmark seeds), so its external mission identifier is deliberately
-- not constrained to a local run row.

CREATE TABLE agent_feedback (
  feedback_id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  reviewer text NOT NULL,
  value smallint NOT NULL CHECK (value BETWEEN 0 AND 100),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  text text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX agent_feedback_agent_created_idx
  ON agent_feedback (agent_id, created_at, feedback_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_feedback TO agora_runtime;
  END IF;
END
$$;
