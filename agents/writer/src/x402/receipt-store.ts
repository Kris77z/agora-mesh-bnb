import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProcessPostgresStore, PostgresCoordinationStore, withLocalFileLock } from "@rebel/shared";
import type {
  X402ExecuteSuccessResponse,
  X402ExecutionRequest,
  X402PaymentCompleted
} from "@rebel/shared";

export interface StoredX402Execution {
  idempotencyKey: string;
  requestHash: string;
  serviceId: string;
  request?: X402ExecutionRequest;
  payment?: X402PaymentCompleted;
  response?: X402ExecuteSuccessResponse;
  settlement?: { state: "attempting" | "uncertain"; startedAt: number };
  lastError?: string;
  updatedAt: number;
}

interface ReceiptStoreFile {
  version: 1;
  records: Record<string, StoredX402Execution>;
}

export interface X402ExecutionStore {
  get(idempotencyKey: string): Promise<StoredX402Execution | undefined>;
  save(record: StoredX402Execution): Promise<void>;
  beginSettlement(record: StoredX402Execution): Promise<boolean>;
}

export class FileX402ExecutionStore implements X402ExecutionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  private async readStore(): Promise<ReceiptStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as ReceiptStoreFile;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("x402 receipt store has an unsupported format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: ReceiptStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

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

  get(idempotencyKey: string): Promise<StoredX402Execution | undefined> {
    return this.serialized(async () => (await this.readStore()).records[idempotencyKey]);
  }

  save(record: StoredX402Execution): Promise<void> {
    return withLocalFileLock(this.storePath, async () => {
      const store = await this.readStore();
      store.records[record.idempotencyKey] = record;
      await this.writeStore(store);
    });
  }

  /** Compare-and-set is shared across local processes, not just HTTP requests. */
  beginSettlement(record: StoredX402Execution): Promise<boolean> {
    return withLocalFileLock(this.storePath, async () => {
      const store = await this.readStore();
      const existing = store.records[record.idempotencyKey];
      if (existing?.settlement || existing?.payment || existing?.response) return false;
      store.records[record.idempotencyKey] = record;
      await this.writeStore(store);
      return true;
    });
  }
}

function bareHash(value: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("x402 hash must be 32 bytes");
  return normalized.toLowerCase();
}

function executionState(record: StoredX402Execution): string {
  if (record.response) return "completed";
  if (record.payment && record.lastError) return "execution_pending";
  if (record.payment) return "paid";
  if (record.settlement?.state === "uncertain") return "settlement_uncertain";
  return "settlement_attempting";
}

export class PostgresX402ExecutionStore implements X402ExecutionStore {
  constructor(private readonly database: PostgresCoordinationStore) {}

  async get(idempotencyKey: string): Promise<StoredX402Execution | undefined> {
    const result = await this.database.pool.query<{
      service_id: string;
      request_hash: string;
      request: X402ExecutionRequest;
      payment_evidence: X402PaymentCompleted | null;
      response: X402ExecuteSuccessResponse | null;
      state: string;
      last_error: string | null;
      updated_at: Date | string;
      created_at: Date | string;
    }>(`
      SELECT service_id, request_hash, request, payment_evidence, response,
             state, last_error, updated_at, created_at
      FROM x402_executions
      WHERE idempotency_key_hash = $1
    `, [bareHash(idempotencyKey)]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      idempotencyKey,
      requestHash: row.request.requestHash,
      serviceId: row.service_id,
      request: row.request,
      ...(row.payment_evidence ? { payment: row.payment_evidence } : {}),
      ...(row.response ? { response: row.response } : {}),
      ...(["settlement_attempting", "settlement_uncertain"].includes(row.state)
        ? {
            settlement: {
              state: row.state === "settlement_uncertain" ? "uncertain" as const : "attempting" as const,
              startedAt: Math.floor(new Date(row.created_at).getTime() / 1_000)
            }
          }
        : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1_000)
    };
  }

  async beginSettlement(record: StoredX402Execution): Promise<boolean> {
    if (!record.request) throw new Error("x402 settlement intent requires the original request");
    const result = await this.database.pool.query(`
      INSERT INTO x402_executions (
        execution_id, service_id, idempotency_key_hash, request_hash,
        purchase_id, state, request, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3,
        (SELECT purchase_id FROM x402_purchases WHERE mission_id = $4 AND service_id = $1),
        'settlement_attempting', $5::jsonb, to_timestamp($6), to_timestamp($6)
      )
      ON CONFLICT (service_id, idempotency_key_hash) DO NOTHING
    `, [
      record.serviceId, bareHash(record.idempotencyKey), bareHash(record.requestHash),
      record.request.missionId, JSON.stringify(record.request), record.settlement?.startedAt ?? record.updatedAt
    ]);
    return result.rowCount === 1;
  }

  async save(record: StoredX402Execution): Promise<void> {
    if (!record.request) throw new Error("x402 execution persistence requires the original request");
    const idempotencyKeyHash = bareHash(record.idempotencyKey);
    if (!await this.get(record.idempotencyKey)) {
      await this.beginSettlement({
        ...record,
        settlement: record.settlement ?? { state: "attempting", startedAt: record.updatedAt }
      });
    }
    if (record.payment) {
      await this.database.recordConfirmedPayment({
        serviceId: record.serviceId,
        idempotencyKeyHash,
        paymentEvidence: record.payment,
        transaction: {
          chainId: record.payment.amount.asset.chainId,
          txHash: record.payment.transaction,
          purpose: "x402-payment",
          fromAddress: record.payment.payer,
          toAddress: record.payment.recipient,
          assetAddress: record.payment.amount.asset.address,
          amount: record.payment.amount.amount,
          metadata: {
            requestHash: record.requestHash,
            idempotencyKey: record.idempotencyKey,
            serviceId: record.serviceId
          }
        }
      });
    }
    const state = executionState(record);
    if (state === "settlement_uncertain") {
      await this.database.markSettlementUncertain(
        record.serviceId,
        idempotencyKeyHash,
        record.lastError ?? "settlement outcome unknown"
      );
    }
    await this.database.pool.query(`
      UPDATE x402_executions
      SET state = CASE WHEN state = 'completed' THEN state ELSE $3 END,
          request = $4::jsonb,
          payment_evidence = COALESCE($5::jsonb, payment_evidence),
          response = COALESCE($6::jsonb, response),
          last_error = CASE WHEN state = 'completed' THEN last_error ELSE $7 END,
          updated_at = to_timestamp($8)
      WHERE service_id = $1 AND idempotency_key_hash = $2
    `, [
      record.serviceId, idempotencyKeyHash, state, JSON.stringify(record.request),
      record.payment ? JSON.stringify(record.payment) : null,
      record.response ? JSON.stringify(record.response) : null,
      record.lastError ?? null, record.updatedAt
    ]);
    if (state === "completed") {
      await this.database.pool.query(`
        UPDATE x402_purchases p
        SET state = 'completed', result = $3::jsonb, updated_at = clock_timestamp()
        FROM x402_executions e
        WHERE e.service_id = $1 AND e.idempotency_key_hash = $2
          AND p.purchase_id = e.purchase_id
      `, [record.serviceId, idempotencyKeyHash, JSON.stringify(record.response)]);
    }
  }
}

export async function openX402ExecutionStore(
  storePath: string,
  applicationName = "agora-writer-maintenance"
): Promise<X402ExecutionStore> {
  const postgres = await getProcessPostgresStore(applicationName);
  return postgres
    ? new PostgresX402ExecutionStore(postgres)
    : new FileX402ExecutionStore(storePath);
}
