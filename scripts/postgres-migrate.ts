import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const defaultMigrationUrl =
  "postgresql://agora_migrator:agora_migrator_local@127.0.0.1:55432/agora_mesh";
const databaseUrl = process.env.AGORA_MIGRATION_DATABASE_URL ?? defaultMigrationUrl;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../database/migrations"
);

function migrationVersion(fileName: string): string {
  const match = /^(\d+)[-_].+\.sql$/.exec(fileName);
  if (!match) throw new Error(`Invalid migration file name: ${fileName}`);
  return match[1];
}

async function main(): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "agora-mesh-migrator",
    statement_timeout: 30_000,
    lock_timeout: 5_000
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('agora_mesh_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        file_name text NOT NULL,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const files = (await readdir(migrationsDirectory))
      .filter((fileName) => /^\d+[-_].+\.sql$/.test(fileName))
      .sort();
    for (const fileName of files) {
      const version = migrationVersion(fileName);
      const sql = await readFile(path.join(migrationsDirectory, fileName), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${version} checksum does not match ${fileName}`);
        }
        console.log(`[db] ${fileName}: already applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version, file_name, checksum) VALUES ($1, $2, $3)",
          [version, fileName, checksum]
        );
        await client.query("COMMIT");
        console.log(`[db] ${fileName}: applied`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('agora_mesh_schema_migrations'))").catch(() => undefined);
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
