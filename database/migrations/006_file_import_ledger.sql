-- Records a completed, atomic file-store cutover. The manifest contains file
-- names, hashes and aggregate counts only; secret material is never imported.

CREATE TABLE file_imports (
  source_digest char(64) PRIMARY KEY CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  row_counts jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    GRANT SELECT, INSERT ON file_imports TO agora_runtime;
  END IF;
END
$$;
