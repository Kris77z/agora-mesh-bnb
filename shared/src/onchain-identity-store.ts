import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withLocalFileLock } from "./file-lock.js";
import { getProcessPostgresStore } from "./storage-backend.js";

export interface OnchainIdentityRecord {
  key: string;
  role: "hunter" | "writer";
  registryAddress: string;
  chainId: number;
  walletAddress: string;
  agentUri: string;
  txHash: string;
  agentTokenId?: string;
  registeredAt: number;
  agentWalletAddress?: string;
  agentWalletSetTxHash?: string;
  agentWalletSetAt?: number;
  agentWalletSetDeadline?: number;
  agentWalletSignatureProfileId?: string;
}

interface OnchainIdentityStore {
  records: OnchainIdentityRecord[];
}

const onchainIdentityStorePath = path.resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.ONCHAIN_IDENTITY_STORE_PATH ?? "./registry/onchain-identity-store.json"
);

async function readStore(): Promise<OnchainIdentityStore> {
  try {
    const content = await readFile(onchainIdentityStorePath, "utf8");
    const parsed = JSON.parse(content) as OnchainIdentityStore;
    if (!Array.isArray(parsed.records)) {
      return { records: [] };
    }
    return parsed;
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return { records: [] };
    }
    throw error;
  }
}

async function writeStore(store: OnchainIdentityStore): Promise<void> {
  await mkdir(path.dirname(onchainIdentityStorePath), { recursive: true });
  const tempPath = `${onchainIdentityStorePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, onchainIdentityStorePath);
}

export async function getOnchainIdentityRecord(key: string): Promise<OnchainIdentityRecord | undefined> {
  const postgres = await getProcessPostgresStore("agora-onchain-identity");
  if (postgres) {
    const result = await postgres.pool.query<{ record: OnchainIdentityRecord }>(
      "SELECT record FROM onchain_identities WHERE identity_key = $1",
      [key]
    );
    return result.rows[0]?.record;
  }
  const store = await readStore();
  return store.records.find((item) => item.key === key);
}

export async function upsertOnchainIdentityRecord(record: OnchainIdentityRecord): Promise<void> {
  const postgres = await getProcessPostgresStore("agora-onchain-identity");
  if (postgres) {
    await postgres.pool.query(`
      INSERT INTO onchain_identities (
        identity_key, role, registry_address, chain_id, wallet_address,
        record, registered_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (identity_key) DO UPDATE SET
        role = EXCLUDED.role,
        registry_address = EXCLUDED.registry_address,
        chain_id = EXCLUDED.chain_id,
        wallet_address = EXCLUDED.wallet_address,
        record = EXCLUDED.record,
        registered_at = EXCLUDED.registered_at,
        updated_at = clock_timestamp()
    `, [
      record.key, record.role, record.registryAddress, record.chainId,
      record.walletAddress, JSON.stringify(record), new Date(record.registeredAt * 1_000)
    ]);
    return;
  }
  await withLocalFileLock(onchainIdentityStorePath, async () => {
    const store = await readStore();
    const filtered = store.records.filter((item) => item.key !== record.key);
    filtered.push(record);
    await writeStore({ records: filtered });
  });
}
