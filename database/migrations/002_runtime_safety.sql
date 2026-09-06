-- Keep migrations append-only after local/production application. This migration
-- widens the API mode vocabulary and constrains authority material to secret refs.

ALTER TABLE runs DROP CONSTRAINT runs_request_mode_check;
ALTER TABLE runs ADD CONSTRAINT runs_request_mode_check
  CHECK (request_mode IN ('single', 'scripted', 'react', 'commander'));

ALTER TABLE authorities DROP CONSTRAINT authorities_encrypted_material_ref_check;
ALTER TABLE authorities ADD CONSTRAINT authorities_encrypted_material_ref_check
  CHECK (
    encrypted_material_ref IS NULL OR
    encrypted_material_ref ~ '^(kms|secret|keychain)://[A-Za-z0-9._:/@-]+$'
  );
