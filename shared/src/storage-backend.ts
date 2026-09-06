import {
  PostgresCoordinationStore,
  assertPostgresSchemaCurrent,
  createPostgresPool
} from "./postgres-coordination-store.js";

export type StoreBackend = "file" | "postgres";

export interface StoreBackendConfig {
  backend: StoreBackend;
  databaseUrl?: string;
  poolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readStoreBackendConfig(): StoreBackendConfig {
  const raw = process.env.STORE_BACKEND?.trim().toLowerCase() || "file";
  if (raw !== "file" && raw !== "postgres") {
    throw new Error("STORE_BACKEND must be file or postgres");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  if (raw === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when STORE_BACKEND=postgres");
  }
  return {
    backend: raw,
    databaseUrl,
    poolMax: integerEnv("POSTGRES_POOL_MAX", 8, 1, 100),
    statementTimeoutMs: integerEnv("POSTGRES_STATEMENT_TIMEOUT_MS", 15_000, 100, 300_000),
    lockTimeoutMs: integerEnv("POSTGRES_LOCK_TIMEOUT_MS", 3_000, 100, 60_000)
  };
}

export function createConfiguredPostgresStore(
  config: StoreBackendConfig,
  applicationName: string
): PostgresCoordinationStore | undefined {
  if (config.backend !== "postgres") return undefined;
  const pool = createPostgresPool({
    connectionString: config.databaseUrl!,
    applicationName,
    maxConnections: config.poolMax,
    statementTimeoutMs: config.statementTimeoutMs,
    lockTimeoutMs: config.lockTimeoutMs
  });
  return new PostgresCoordinationStore(pool);
}

export async function assertConfiguredPostgresReady(
  store: PostgresCoordinationStore | undefined
): Promise<void> {
  if (store) await assertPostgresSchemaCurrent(store.pool);
}

let processStore: {
  store: PostgresCoordinationStore;
  ready: Promise<void>;
} | undefined;

export async function getProcessPostgresStore(
  applicationName: string
): Promise<PostgresCoordinationStore | undefined> {
  const config = readStoreBackendConfig();
  if (config.backend !== "postgres") return undefined;
  if (!processStore) {
    const store = createConfiguredPostgresStore(config, applicationName)!;
    processStore = { store, ready: assertConfiguredPostgresReady(store) };
  }
  await processStore.ready;
  return processStore.store;
}

export async function closeProcessPostgresStores(): Promise<void> {
  const entry = processStore;
  processStore = undefined;
  if (entry) await entry.store.pool.end();
}
