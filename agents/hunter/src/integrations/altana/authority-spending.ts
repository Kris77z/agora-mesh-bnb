import { ethers } from "ethers";
import { readFile } from "node:fs/promises";
import type { AssetRef, AuthorityRecord, HexAddress, HexHash, PostgresCoordinationStore } from "@rebel/shared";

const TRANSFER_INTERFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const LOG_CHUNK_SIZE = 2_000;

export interface AuthorityTransferEvidence {
  txHash: HexHash;
  blockNumber: number;
  timestamp: number;
  recipient: HexAddress;
  amount: string;
  serviceId?: string;
}

export interface AuthoritySpendSummary {
  asset: AssetRef;
  period: "total" | "day";
  limit: string;
  spent: string;
  remaining: string;
  evidenceSource: "x402-receipt-store" | "erc20-transfer-logs" | "unsupported";
  transactions: AuthorityTransferEvidence[];
}

interface DecodedTransfer {
  txHash: HexHash;
  blockNumber: number;
  timestamp: number;
  recipient: HexAddress;
  amount: bigint;
  serviceId?: string;
}

interface ReceiptTransfer extends DecodedTransfer {
  asset: AssetRef;
}

interface X402ReceiptStore {
  version?: unknown;
  records?: Record<string, {
    serviceId?: unknown;
    updatedAt?: unknown;
    payment?: {
      status?: unknown;
      rail?: unknown;
      transaction?: unknown;
      payer?: unknown;
      recipient?: unknown;
      amount?: { asset?: AssetRef; amount?: unknown };
    };
    response?: { receipt?: { timestamp?: unknown } };
  }>;
}

type X402ReceiptRecord = NonNullable<X402ReceiptStore["records"]>[string];

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.chainId === right.chainId &&
    left.kind === right.kind &&
    left.address?.toLowerCase() === right.address?.toLowerCase();
}

async function loadReceiptTransfers(
  authority: AuthorityRecord,
  storePaths: string[],
  evidenceEnd?: number,
  database?: PostgresCoordinationStore
): Promise<ReceiptTransfer[] | undefined> {
  let loadedStore = false;
  const transfers: ReceiptTransfer[] = [];
  const allowedRecipients = new Set(authority.allowedCalls.map((call) => call.to.toLowerCase()));
  const authorityCreatedAt = normalizeUnixSeconds(authority.createdAt);
  const evidenceEndAt = evidenceEnd === undefined ? undefined : normalizeUnixSeconds(evidenceEnd);
  const stores: X402ReceiptStore[] = [];
  if (database) {
    const rows = await database.listX402ExecutionEvidence();
    stores.push({
      version: 1,
      records: Object.fromEntries(rows.map((row) => [
        `${row.serviceId}:${row.idempotencyKeyHash}`,
        {
          serviceId: row.serviceId,
          updatedAt: Math.floor(Date.parse(row.updatedAt) / 1_000),
          payment: row.payment as X402ReceiptRecord["payment"],
          response: row.response as X402ReceiptRecord["response"]
        }
      ]))
    });
    loadedStore = true;
  } else {
    for (const storePath of storePaths) {
      try {
        stores.push(JSON.parse(await readFile(storePath, "utf8")) as X402ReceiptStore);
        loadedStore = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }
  for (const parsed of stores) {
    for (const record of Object.values(parsed.records ?? {})) {
      const payment = record.payment;
      const asset = payment?.amount?.asset;
      if (
        payment?.status !== "payment-completed" ||
        payment.rail !== "x402" ||
        typeof payment.transaction !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(payment.transaction) ||
        typeof payment.payer !== "string" ||
        payment.payer.toLowerCase() !== authority.walletAddress.toLowerCase() ||
        typeof payment.recipient !== "string" ||
        !allowedRecipients.has(payment.recipient.toLowerCase()) ||
        !asset ||
        typeof payment.amount?.amount !== "string" ||
        !/^\d+$/.test(payment.amount.amount)
      ) {
        continue;
      }
      const rawTimestamp = record.response?.receipt?.timestamp ?? record.updatedAt;
      if (typeof rawTimestamp !== "number" || !Number.isSafeInteger(rawTimestamp) || rawTimestamp <= 0) {
        continue;
      }
      const timestamp = normalizeUnixSeconds(rawTimestamp);
      // A wallet and an approved recipient can be reused by multiple scoped
      // Authorities. Receipt fallback therefore has to be constrained to this
      // Authority's lifetime; otherwise unrelated historical/future payments
      // are incorrectly attributed to the displayed cap.
      if (timestamp < authorityCreatedAt || (evidenceEndAt !== undefined && timestamp > evidenceEndAt)) {
        continue;
      }
      transfers.push({
        txHash: payment.transaction as HexHash,
        blockNumber: 0,
        timestamp,
        recipient: ethers.getAddress(payment.recipient) as HexAddress,
        amount: BigInt(payment.amount.amount),
        asset,
        serviceId: typeof record.serviceId === "string" && record.serviceId.trim()
          ? record.serviceId.trim()
          : undefined
      });
    }
  }
  if (!loadedStore) {
    return undefined;
  }
  const unique = new Map(transfers.map((transfer) => [transfer.txHash.toLowerCase(), transfer]));
  return [...unique.values()];
}

function normalizeUnixSeconds(timestamp: number): number {
  return timestamp >= 100_000_000_000 ? Math.floor(timestamp / 1_000) : Math.floor(timestamp);
}

export function summarizeAuthorityTransfers(input: {
  asset: AssetRef;
  period: "total" | "day";
  limit: string;
  transfers: DecodedTransfer[];
  now: number;
}): AuthoritySpendSummary {
  if (!/^\d+$/.test(input.limit)) {
    throw new Error("Authority spend limit must be an integer string");
  }
  const windowStart = input.period === "day"
    ? Math.floor(input.now / 86_400) * 86_400
    : 0;
  const transactions = input.transfers
    .filter((transfer) => transfer.timestamp >= windowStart)
    .sort((left, right) => left.blockNumber - right.blockNumber)
    .map((transfer) => ({
      txHash: transfer.txHash,
      blockNumber: transfer.blockNumber,
      timestamp: transfer.timestamp,
      recipient: transfer.recipient,
      amount: transfer.amount.toString(),
      serviceId: transfer.serviceId
    }));
  const spent = transactions.reduce((sum, transaction) => sum + BigInt(transaction.amount), 0n);
  const limit = BigInt(input.limit);
  return {
    asset: input.asset,
    period: input.period,
    limit: input.limit,
    spent: spent.toString(),
    remaining: (spent >= limit ? 0n : limit - spent).toString(),
    evidenceSource: "erc20-transfer-logs",
    transactions
  };
}

async function getLogsInChunks(
  provider: ethers.JsonRpcProvider,
  filter: Omit<ethers.Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number
): Promise<ethers.Log[]> {
  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    ranges.push({ fromBlock: start, toBlock: Math.min(toBlock, start + LOG_CHUNK_SIZE - 1) });
  }
  const logs: ethers.Log[] = [];
  for (const range of ranges) {
    logs.push(...await provider.getLogs({ ...filter, ...range }));
  }
  return logs;
}

async function readErc20Transfers(input: {
  provider: ethers.JsonRpcProvider;
  authority: AuthorityRecord;
  token: HexAddress;
  fromBlock: number;
  toBlock: number;
}): Promise<DecodedTransfer[]> {
  const logs = await getLogsInChunks(
    input.provider,
    {
      address: input.token,
      topics: [TRANSFER_TOPIC, ethers.zeroPadValue(input.authority.walletAddress, 32)]
    },
    input.fromBlock,
    input.toBlock
  );
  const allowedRecipients = new Set(
    input.authority.allowedCalls.map((call) => call.to.toLowerCase())
  );
  const decoded = logs.flatMap((log): Array<Omit<DecodedTransfer, "timestamp">> => {
    const parsed = TRANSFER_INTERFACE.parseLog(log);
    if (!parsed) {
      return [];
    }
    const recipient = ethers.getAddress(String(parsed.args.to)) as HexAddress;
    if (!allowedRecipients.has(recipient.toLowerCase())) {
      return [];
    }
    return [{
      txHash: log.transactionHash as HexHash,
      blockNumber: log.blockNumber,
      recipient,
      amount: BigInt(parsed.args.value)
    }];
  });
  const blockNumbers = [...new Set(decoded.map((transfer) => transfer.blockNumber))];
  const blocks = await Promise.all(
    blockNumbers.map(async (blockNumber) => [blockNumber, await input.provider.getBlock(blockNumber)] as const)
  );
  const timestamps = new Map(
    blocks.map(([blockNumber, block]) => [blockNumber, block?.timestamp ?? 0])
  );
  return decoded.map((transfer) => ({
    ...transfer,
    timestamp: timestamps.get(transfer.blockNumber) ?? 0
  }));
}

export async function readAuthoritySpending(input: {
  authority: AuthorityRecord;
  rpcUrl: string;
  receiptStorePaths?: string[];
  receiptEvidenceOnly?: boolean;
  receiptEvidenceEnd?: number;
  database?: PostgresCoordinationStore;
  now?: number;
}): Promise<AuthoritySpendSummary[]> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const receiptTransfers = input.receiptStorePaths
    ? await loadReceiptTransfers(
        input.authority,
        input.receiptStorePaths,
        input.receiptEvidenceEnd,
        input.database
      )
    : undefined;
  // Receipt stores are useful for legacy authorities that predate a persisted
  // grant transaction. For a real on-chain Authority, however, transfer logs
  // are the source of truth: an HTTP response can be lost after settlement and
  // leave a valid token transfer without a stored receipt.
  if (receiptTransfers && (input.receiptEvidenceOnly || !input.authority.grantTxHash)) {
    return input.authority.spendLimits.map((spendLimit) => ({
      ...summarizeAuthorityTransfers({
        asset: spendLimit.asset,
        period: spendLimit.period,
        limit: spendLimit.limit,
        transfers: receiptTransfers.filter((transfer) => sameAsset(transfer.asset, spendLimit.asset)),
        now
      }),
      evidenceSource: "x402-receipt-store"
    }));
  }

  const provider = new ethers.JsonRpcProvider(input.rpcUrl);
  const latestBlock = await provider.getBlockNumber();
  const grantReceipt = input.authority.grantTxHash
    ? await provider.getTransactionReceipt(input.authority.grantTxHash)
    : undefined;
  const fromBlock = grantReceipt?.blockNumber ?? latestBlock;
  return Promise.all(
    input.authority.spendLimits.map(async (spendLimit): Promise<AuthoritySpendSummary> => {
      const asset = spendLimit.asset;
      if (asset.kind !== "erc20" || !asset.address) {
        return {
          asset,
          period: spendLimit.period,
          limit: spendLimit.limit,
          spent: "0",
          remaining: spendLimit.limit,
          evidenceSource: "unsupported",
          transactions: []
        };
      }
      const transfers = await readErc20Transfers({
        provider,
        authority: input.authority,
        token: asset.address,
        fromBlock,
        toBlock: latestBlock
      });
      const receiptByTransaction = new Map(
        (receiptTransfers ?? [])
          .filter((transfer) => sameAsset(transfer.asset, asset))
          .map((transfer) => [transfer.txHash.toLowerCase(), transfer] as const)
      );
      return summarizeAuthorityTransfers({
        asset,
        period: spendLimit.period,
        limit: spendLimit.limit,
        transfers: transfers.map((transfer) => ({
          ...transfer,
          serviceId: receiptByTransaction.get(transfer.txHash.toLowerCase())?.serviceId
        })),
        now
      });
    })
  );
}
