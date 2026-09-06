import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getProcessPostgresStore,
  PostgresCoordinationStore,
  withLocalFileLock,
  type ServiceInfo,
  type X402Accept,
  type X402ExecutionRequest,
  type X402PaymentRequirement
} from "@rebel/shared";

export interface StoredX402Purchase {
  service: ServiceInfo;
  request: X402ExecutionRequest;
  requirement: X402PaymentRequirement;
  selectedAccept: X402Accept;
}
export interface X402PurchaseStore {
  get(key: string): Promise<StoredX402Purchase | undefined>;
  create(key: string, record: StoredX402Purchase): Promise<boolean>;
}
export function purchaseKey(missionId: string, serviceId: string): string {
  return createHash("sha256").update(JSON.stringify([missionId, serviceId])).digest("hex");
}

/** Intent only; never stores a payment signature or private key. */
export class FileX402PurchaseStore implements X402PurchaseStore {
  constructor(private readonly directory: string) {}
  private file(key: string) {
    if (!/^[\da-f]{64}$/.test(key)) throw new Error("Invalid purchase journal key");
    return path.join(this.directory, `${key}.json`);
  }
  async get(key: string): Promise<StoredX402Purchase | undefined> {
    try { return JSON.parse(await readFile(this.file(key), "utf8")) as StoredX402Purchase; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async create(key: string, record: StoredX402Purchase): Promise<boolean> {
    const file = this.file(key);
    return withLocalFileLock(file, async () => {
      if (await this.get(key)) return false;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, file);
      return true;
    });
  }
}

function bareHash(value: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("x402 hash must be 32 bytes");
  return normalized.toLowerCase();
}

export class PostgresX402PurchaseStore implements X402PurchaseStore {
  constructor(private readonly database: PostgresCoordinationStore) {}

  async get(key: string): Promise<StoredX402Purchase | undefined> {
    const result = await this.database.pool.query<{
      service: ServiceInfo;
      request: X402ExecutionRequest;
      requirement: X402PaymentRequirement;
      selected_accept: X402Accept;
    }>(`
      SELECT service, request, requirement, selected_accept
      FROM x402_purchases WHERE idempotency_key_hash = $1
    `, [bareHash(key)]);
    const row = result.rows[0];
    return row ? {
      service: row.service,
      request: row.request,
      requirement: row.requirement,
      selectedAccept: row.selected_accept
    } : undefined;
  }

  async create(key: string, record: StoredX402Purchase): Promise<boolean> {
    const chainMatch = /^eip155:(\d+)$/.exec(record.selectedAccept.network);
    const chainId = chainMatch ? Number(chainMatch[1]) : record.service.asset?.chainId;
    if (!chainId || !Number.isSafeInteger(chainId)) throw new Error("x402 purchase network is invalid");
    const created = await this.database.createPurchase({
      missionId: record.request.missionId,
      serviceId: record.request.serviceId,
      idempotencyKeyHash: bareHash(key),
      requestHash: bareHash(record.request.requestHash),
      chainId,
      assetKind: "erc20",
      assetAddress: record.selectedAccept.asset,
      assetSymbol: record.service.asset?.symbol ?? record.service.currency,
      assetDecimals: record.service.asset?.decimals ?? 18,
      amount: record.selectedAccept.amount,
      recipient: record.selectedAccept.payTo,
      request: record.request,
      requirement: record.requirement,
      selectedAccept: record.selectedAccept,
      service: record.service
    });
    return created.created;
  }
}

export async function openX402PurchaseStore(directory: string): Promise<X402PurchaseStore> {
  const postgres = await getProcessPostgresStore("agora-hunter");
  return postgres
    ? new PostgresX402PurchaseStore(postgres)
    : new FileX402PurchaseStore(directory);
}
