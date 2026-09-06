import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthorityRecord, HexAddress, HexHash, PostgresCoordinationStore } from "@rebel/shared";
import { getProcessPostgresStore, withLocalFileLock } from "@rebel/shared";

export interface AuthorityNegativeTestEvidence {
  kind: "erc20-transfer";
  recipient: HexAddress;
  amount: string;
  testedAt: number;
  rejected: boolean;
  outcome?: "rejected" | "unexpected-success" | "inconclusive";
  rejection?: string;
  unexpectedTxHash?: HexHash;
}

export interface AuthorityRevocationEvidence {
  checkerApprovalTxHash: HexHash;
  permit2AllowanceTxHash: HexHash;
  sessionRevokeTxHash: HexHash;
  negativeTest?: AuthorityNegativeTestEvidence;
  sessionMaterialDeleted: boolean;
}

export interface StoredAuthorityEvidence {
  authority: AuthorityRecord;
  lifecycle?: {
    operation: "provision" | "revoke";
    phase: "in-progress" | "blocked" | "complete";
    pendingStep?: AuthorityLifecycleStep;
    transactions: Partial<Record<AuthorityLifecycleStep, HexHash>>;
    reconciled?: Partial<Record<AuthorityLifecycleStep, { checkedAt: number; evidence: "onchain-state" }>>;
  };
  revocation?: AuthorityRevocationEvidence;
  updatedAt: number;
}

export type AuthorityLifecycleStep = "grantSession" | "approveChecker" | "approveAllowance" |
  "revokeChecker" | "revokeAllowance" | "revokeSession";

interface AuthorityEvidenceStoreFile {
  version: 1;
  records: Record<string, StoredAuthorityEvidence>;
}

export interface AuthorityEvidenceStore {
  get(authorityId: string): Promise<StoredAuthorityEvidence | undefined>;
  save(record: StoredAuthorityEvidence): Promise<void>;
}

export class FileAuthorityEvidenceStore implements AuthorityEvidenceStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readStore(): Promise<AuthorityEvidenceStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as AuthorityEvidenceStoreFile;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("Authority evidence store has an unsupported format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: AuthorityEvidenceStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

  get(authorityId: string): Promise<StoredAuthorityEvidence | undefined> {
    return this.serialized(async () => (await this.readStore()).records[authorityId]);
  }

  save(record: StoredAuthorityEvidence): Promise<void> {
    return withLocalFileLock(this.storePath, async () => {
      const store = await this.readStore();
      store.records[record.authority.authorityId] = record;
      await this.writeStore(store);
    });
  }
}

function epochDate(value: number): Date {
  return new Date(value >= 100_000_000_000 ? value : value * 1_000);
}

export class PostgresAuthorityEvidenceStore implements AuthorityEvidenceStore {
  constructor(private readonly database: PostgresCoordinationStore) {}

  async get(authorityId: string): Promise<StoredAuthorityEvidence | undefined> {
    const result = await this.database.pool.query<{
      authority_id: string;
      wallet_address: HexAddress;
      session_public_key: HexAddress;
      chain_id: string;
      allowed_calls: AuthorityRecord["allowedCalls"];
      spend_limits: AuthorityRecord["spendLimits"];
      expires_at: Date | string;
      status: AuthorityRecord["status"];
      lifecycle: StoredAuthorityEvidence["lifecycle"] | null;
      revocation: StoredAuthorityEvidence["revocation"] | null;
      created_at: Date | string;
      updated_at: Date | string;
      grant_tx_hash: HexHash | null;
      revoke_tx_hash: HexHash | null;
    }>(`
      SELECT a.*,
        grant_tx.tx_hash AS grant_tx_hash,
        revoke_tx.tx_hash AS revoke_tx_hash
      FROM authorities a
      LEFT JOIN chain_transactions grant_tx ON grant_tx.transaction_id = a.grant_transaction_id
      LEFT JOIN chain_transactions revoke_tx ON revoke_tx.transaction_id = a.revoke_transaction_id
      WHERE a.authority_id = $1
    `, [authorityId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      authority: {
        authorityId: row.authority_id,
        walletAddress: row.wallet_address,
        sessionPublicKey: row.session_public_key,
        chainId: Number(row.chain_id),
        allowedCalls: row.allowed_calls,
        spendLimits: row.spend_limits,
        expiry: Math.floor(new Date(row.expires_at).getTime() / 1_000),
        status: row.status,
        ...(row.grant_tx_hash ? { grantTxHash: row.grant_tx_hash } : {}),
        ...(row.revoke_tx_hash ? { revokeTxHash: row.revoke_tx_hash } : {}),
        createdAt: new Date(row.created_at).getTime()
      },
      ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}),
      ...(row.revocation ? { revocation: row.revocation } : {}),
      updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1_000)
    };
  }

  async save(record: StoredAuthorityEvidence): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const hashes = new Map<HexHash, string>();
      const evidenceHashes = [
        record.authority.grantTxHash,
        record.authority.revokeTxHash,
        ...Object.values(record.lifecycle?.transactions ?? {})
      ].filter((value): value is HexHash => typeof value === "string");
      for (const txHash of new Set(evidenceHashes)) {
        const pendingHash = record.lifecycle?.pendingStep
          ? record.lifecycle.transactions[record.lifecycle.pendingStep]
          : undefined;
        const status = pendingHash === txHash ? "submitted" : "confirmed";
        const transaction = await client.query<{ transaction_id: string }>(`
          INSERT INTO chain_transactions (
            transaction_id, chain_id, tx_hash, purpose, status, metadata, confirmed_at
          ) VALUES ($1, $2, $3, 'authority-lifecycle', $4, $5::jsonb,
                    CASE WHEN $4 = 'confirmed' THEN $6::timestamptz ELSE NULL END)
          ON CONFLICT (chain_id, tx_hash) DO UPDATE SET
            status = CASE WHEN EXCLUDED.status = 'confirmed' THEN 'confirmed' ELSE chain_transactions.status END,
            metadata = chain_transactions.metadata || EXCLUDED.metadata,
            confirmed_at = COALESCE(chain_transactions.confirmed_at, EXCLUDED.confirmed_at)
          RETURNING transaction_id
        `, [
          randomUUID(), record.authority.chainId, txHash, status,
          JSON.stringify({ authorityId: record.authority.authorityId }),
          epochDate(record.updatedAt)
        ]);
        hashes.set(txHash, transaction.rows[0].transaction_id);
      }
      await client.query(`
        INSERT INTO authorities (
          authority_id, wallet_address, session_public_key, chain_id,
          allowed_calls, spend_limits, expires_at, status,
          grant_transaction_id, revoke_transaction_id,
          lifecycle, revocation, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8,
          $9, $10, $11::jsonb, $12::jsonb, $13, $14
        )
        ON CONFLICT (authority_id) DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          session_public_key = EXCLUDED.session_public_key,
          chain_id = EXCLUDED.chain_id,
          allowed_calls = EXCLUDED.allowed_calls,
          spend_limits = EXCLUDED.spend_limits,
          expires_at = EXCLUDED.expires_at,
          status = EXCLUDED.status,
          grant_transaction_id = COALESCE(EXCLUDED.grant_transaction_id, authorities.grant_transaction_id),
          revoke_transaction_id = COALESCE(EXCLUDED.revoke_transaction_id, authorities.revoke_transaction_id),
          lifecycle = EXCLUDED.lifecycle,
          revocation = EXCLUDED.revocation,
          updated_at = EXCLUDED.updated_at
      `, [
        record.authority.authorityId,
        record.authority.walletAddress,
        record.authority.sessionPublicKey,
        record.authority.chainId,
        JSON.stringify(record.authority.allowedCalls),
        JSON.stringify(record.authority.spendLimits),
        new Date(record.authority.expiry * 1_000),
        record.authority.status,
        record.authority.grantTxHash ? hashes.get(record.authority.grantTxHash) : null,
        record.authority.revokeTxHash ? hashes.get(record.authority.revokeTxHash) : null,
        record.lifecycle ? JSON.stringify(record.lifecycle) : null,
        record.revocation ? JSON.stringify(record.revocation) : null,
        epochDate(record.authority.createdAt),
        epochDate(record.updatedAt)
      ]);
      const transactions = record.lifecycle?.transactions ?? {};
      const steps = new Set<AuthorityLifecycleStep>([
        ...Object.keys(transactions) as AuthorityLifecycleStep[],
        ...(record.lifecycle?.pendingStep ? [record.lifecycle.pendingStep] : [])
      ]);
      for (const step of steps) {
        const txHash = transactions[step];
        const state = record.lifecycle?.pendingStep === step
          ? (txHash ? "uncertain" : "pending")
          : txHash ? "confirmed" : "pending";
        await client.query(`
          INSERT INTO authority_steps (
            authority_id, step, attempt, state, transaction_id, public_evidence,
            completed_at
          ) VALUES (
            $1, $2, 1, $3, $4, $5::jsonb,
            CASE WHEN $3 = 'confirmed' THEN $6::timestamptz ELSE NULL END
          )
          ON CONFLICT (authority_id, step, attempt) DO UPDATE SET
            state = EXCLUDED.state,
            transaction_id = COALESCE(EXCLUDED.transaction_id, authority_steps.transaction_id),
            public_evidence = EXCLUDED.public_evidence,
            completed_at = EXCLUDED.completed_at
        `, [
          record.authority.authorityId, step, state,
          txHash ? hashes.get(txHash) : null,
          JSON.stringify(txHash ? { txHash } : {}),
          epochDate(record.updatedAt)
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function openAuthorityEvidenceStore(storePath: string): Promise<AuthorityEvidenceStore> {
  const postgres = await getProcessPostgresStore("agora-hunter");
  return postgres
    ? new PostgresAuthorityEvidenceStore(postgres)
    : new FileAuthorityEvidenceStore(storePath);
}
