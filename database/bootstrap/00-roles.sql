-- Local development credentials only. Production roles are created by IaC/DBA and
-- use rotated secrets; application processes never receive the migration role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agora_runtime') THEN
    CREATE ROLE agora_runtime LOGIN PASSWORD 'agora_runtime_local'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE agora_mesh TO agora_runtime;
