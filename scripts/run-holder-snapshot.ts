import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import type { OnchainRiskReport } from "@rebel/shared";
import { tokenRiskReportHash } from "../agents/hunter/src/security-pipeline.js";
import {
  ERC20_TRANSFER_TOPIC,
  holderSharePartsPerMillion,
  replayHolderLedger,
  topHolderSharePartsPerMillion,
  type HolderTransferLog
} from "../agents/writer/src/investigation/holder-snapshot.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const sourcePath = path.join(experimentDirectory, "paid-run-output.json");
const outputPath = path.join(experimentDirectory, "holder-snapshot-output.json");
const transferLogCachePath = path.join(experimentDirectory, "holder-transfer-log-cache.json");
const DEFAULT_ARCHIVE_RPC = "https://bsc-prebsc-dataseed.bnbchain.org";
const FALLBACK_ARCHIVE_RPC = "https://bnb-testnet.api.onfinality.io/public";
const DEFAULT_STATE_RPC = "https://bsc-testnet-rpc.publicnode.com";
const DEFAULT_DISCOVERY_RPC = "https://bnb-testnet.api.onfinality.io/public";
const ERC20 = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
]);

interface RpcLog extends HolderTransferLog {
  blockHash?: string;
  removed?: boolean;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface IndexedHolderCandidate {
  address: string;
  percentage?: string;
  quantity?: string;
  rank: number;
}

class ArchiveRpc {
  private requestId = 0;

  constructor(
    readonly endpoint: string,
    private readonly timeoutMs = 30_000,
    private readonly attempts = 4,
    private readonly backoffMs = 250
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const payload = await response.json() as JsonRpcResponse<T>;
        if (!response.ok || payload.error || payload.result === undefined) {
          throw new Error(payload.error?.message ?? `RPC returned HTTP ${response.status}`);
        }
        return payload.result;
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * this.backoffMs));
        }
      }
    }
    throw lastError;
  }

  async batch<T>(calls: Array<{ method: string; params: unknown[] }>): Promise<T[]> {
    if (calls.length === 0) return [];
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const requests = calls.map((call) => ({
        jsonrpc: "2.0" as const,
        id: ++this.requestId,
        method: call.method,
        params: call.params
      }));
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(requests),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const payload = await response.json() as Array<JsonRpcResponse<T> & { id?: number }>;
        if (!response.ok || !Array.isArray(payload)) {
          throw new Error(`RPC batch returned HTTP ${response.status}`);
        }
        const byId = new Map(payload.map((item) => [item.id, item]));
        return requests.map((request) => {
          const item = byId.get(request.id);
          if (!item || item.error || item.result === undefined) {
            throw new Error(item?.error?.message ?? `RPC batch omitted response ${request.id}`);
          }
          return item.result;
        });
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * this.backoffMs));
        }
      }
    }
    throw lastError;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readTransferLogCache(input: {
  address: string;
  fromBlock: number;
  toBlock: number;
}): Promise<RpcLog[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(transferLogCachePath, "utf8")) as {
      version?: unknown;
      target?: unknown;
      fromBlock?: unknown;
      toBlock?: unknown;
      transferTopic?: unknown;
      logs?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.target !== "string" ||
      parsed.target.toLowerCase() !== input.address.toLowerCase() ||
      parsed.fromBlock !== input.fromBlock ||
      parsed.toBlock !== input.toBlock ||
      parsed.transferTopic !== ERC20_TRANSFER_TOPIC ||
      !Array.isArray(parsed.logs)
    ) return undefined;
    return parsed.logs as RpcLog[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function firstCodeBlock(rpc: ArchiveRpc, address: string, upperBound: number): Promise<number> {
  let low = 0;
  let high = upperBound;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const code = await rpc.call<string>("eth_getCode", [address, ethers.toQuantity(middle)]);
    if (code === "0x") low = middle + 1;
    else high = middle;
  }
  const code = await rpc.call<string>("eth_getCode", [address, ethers.toQuantity(low)]);
  if (code === "0x") throw new Error("Target contract did not exist at the snapshot block");
  return low;
}

function logKey(log: RpcLog): string {
  return `${log.transactionHash.toLowerCase()}:${BigInt(log.logIndex).toString()}`;
}

async function scanTransferRange(input: {
  primary: ArchiveRpc;
  fallback: ArchiveRpc;
  address: string;
  from: number;
  to: number;
}): Promise<RpcLog[]> {
  const params = [{
    address: input.address,
    topics: [ERC20_TRANSFER_TOPIC],
    fromBlock: ethers.toQuantity(input.from),
    toBlock: ethers.toQuantity(input.to)
  }];
  try {
    return await input.primary.call<RpcLog[]>("eth_getLogs", params);
  } catch (primaryError) {
    if (input.to - input.from + 1 <= 10_000) {
      try {
        return await input.fallback.call<RpcLog[]>("eth_getLogs", params);
      } catch {
        throw primaryError;
      }
    }
    const middle = Math.floor((input.from + input.to) / 2);
    const [left, right] = await Promise.all([
      scanTransferRange({ ...input, to: middle }),
      scanTransferRange({ ...input, from: middle + 1 })
    ]);
    return [...left, ...right];
  }
}

async function scanTransferHistory(input: {
  primary: ArchiveRpc;
  fallback: ArchiveRpc;
  address: string;
  from: number;
  to: number;
  chunkSize: number;
  concurrency: number;
}): Promise<RpcLog[]> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let from = input.from; from <= input.to; from += input.chunkSize) {
    ranges.push({ from, to: Math.min(input.to, from + input.chunkSize - 1) });
  }
  let nextRange = 0;
  let completedRanges = 0;
  const allLogs: RpcLog[] = [];
  async function worker(): Promise<void> {
    while (nextRange < ranges.length) {
      const rangeIndex = nextRange++;
      const range = ranges[rangeIndex]!;
      const logs = await scanTransferRange({
        primary: input.primary,
        fallback: input.fallback,
        address: input.address,
        ...range
      });
      allLogs.push(...logs);
      completedRanges += 1;
      if (completedRanges % 10 === 0 || completedRanges === ranges.length) {
        console.error(`holder snapshot: scanned ${completedRanges}/${ranges.length} ranges`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(input.concurrency, ranges.length) }, () => worker()));
  return [...new Map(allLogs.map((log) => [logKey(log), log])).values()];
}

async function readErc20Uint(
  rpc: ArchiveRpc,
  contract: string,
  functionName: "totalSupply" | "balanceOf",
  blockNumber: number,
  args: readonly unknown[] = []
): Promise<bigint> {
  const data = ERC20.encodeFunctionData(functionName, args);
  const result = await rpc.call<string>("eth_call", [
    { to: contract, data },
    ethers.toQuantity(blockNumber)
  ]);
  return BigInt(ERC20.decodeFunctionResult(functionName, result)[0]);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function readIndexedHolderCandidates(filePath: string): Promise<IndexedHolderCandidate[]> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HOLDER_SNAPSHOT_INDEX_PATH must contain a non-empty JSON array");
  }
  const candidates = parsed.map((value, index) => {
    const candidate = value as Partial<IndexedHolderCandidate>;
    if (!ethers.isAddress(candidate.address) || candidate.rank !== index + 1) {
      throw new Error(`Invalid indexed holder at array position ${index}`);
    }
    return {
      address: ethers.getAddress(candidate.address),
      rank: candidate.rank,
      ...(typeof candidate.percentage === "string" ? { percentage: candidate.percentage } : {}),
      ...(typeof candidate.quantity === "string" ? { quantity: candidate.quantity } : {})
    };
  });
  if (new Set(candidates.map((candidate) => candidate.address.toLowerCase())).size !== candidates.length) {
    throw new Error("HOLDER_SNAPSHOT_INDEX_PATH contains duplicate addresses");
  }
  return candidates;
}

async function readBalances(input: {
  rpc: ArchiveRpc;
  contract: string;
  addresses: string[];
  blockNumber: number;
  concurrency: number;
}): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  const batchSize = 75;
  const batches: string[][] = [];
  for (let index = 0; index < input.addresses.length; index += batchSize) {
    batches.push(input.addresses.slice(index, index + batchSize));
  }
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const addresses = batches[cursor++]!;
      const results = await input.rpc.batch<string>(addresses.map((address) => ({
        method: "eth_call",
        params: [{ to: input.contract, data: ERC20.encodeFunctionData("balanceOf", [address]) }, ethers.toQuantity(input.blockNumber)]
      })));
      results.forEach((result, index) => {
        const balance = BigInt(ERC20.decodeFunctionResult("balanceOf", result)[0]);
        balances.set(addresses[index]!.toLowerCase(), balance);
      });
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(input.concurrency, input.addresses.length) },
    () => worker()
  ));
  return balances;
}

async function main(): Promise<void> {
  const sourceRaw = await readFile(sourcePath, "utf8");
  const source = JSON.parse(sourceRaw) as { mission?: { missionId?: unknown }; report?: OnchainRiskReport };
  if (!source.report || source.report.version !== 1 || source.report.target.classification !== "erc20") {
    throw new Error("paid-run-output.json does not contain a version-1 ERC-20 risk report");
  }
  const report = source.report;
  const indexedHolderPath = process.env.HOLDER_SNAPSHOT_INDEX_PATH;
  const endpoint = process.env.HOLDER_SNAPSHOT_RPC_URL || DEFAULT_ARCHIVE_RPC;
  const fallbackEndpoint = process.env.HOLDER_SNAPSHOT_FALLBACK_RPC_URL || FALLBACK_ARCHIVE_RPC;
  const stateEndpoint = process.env.HOLDER_SNAPSHOT_STATE_RPC_URL || DEFAULT_STATE_RPC;
  const discoveryEndpoint = process.env.HOLDER_SNAPSHOT_DISCOVERY_RPC_URL || DEFAULT_DISCOVERY_RPC;
  const logTimeoutMs = Number(process.env.HOLDER_SNAPSHOT_LOG_TIMEOUT_MS || 15_000);
  const configuredCreationBlock = process.env.HOLDER_SNAPSHOT_CREATION_BLOCK
    ? Number(process.env.HOLDER_SNAPSHOT_CREATION_BLOCK)
    : undefined;
  const chunkSize = Number(process.env.HOLDER_SNAPSHOT_CHUNK_SIZE || 500_000);
  const concurrency = Number(process.env.HOLDER_SNAPSHOT_CONCURRENCY || 4);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 1_000_000) {
    throw new Error("HOLDER_SNAPSHOT_CHUNK_SIZE must be an integer between 1 and 1,000,000");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 8) {
    throw new Error("HOLDER_SNAPSHOT_CONCURRENCY must be an integer between 1 and 8");
  }
  if (!Number.isSafeInteger(logTimeoutMs) || logTimeoutMs < 5_000 || logTimeoutMs > 60_000) {
    throw new Error("HOLDER_SNAPSHOT_LOG_TIMEOUT_MS must be an integer between 5,000 and 60,000");
  }
  if (
    configuredCreationBlock !== undefined &&
    (!Number.isSafeInteger(configuredCreationBlock) || configuredCreationBlock < 0 ||
      configuredCreationBlock > report.blockNumber)
  ) {
    throw new Error("HOLDER_SNAPSHOT_CREATION_BLOCK must be a valid block at or before the report block");
  }

  const primary = new ArchiveRpc(endpoint, logTimeoutMs, 1);
  const fallback = new ArchiveRpc(fallbackEndpoint, 20_000, 8, 1_000);
  const state = new ArchiveRpc(stateEndpoint);
  const discovery = new ArchiveRpc(discoveryEndpoint, 20_000, 8, 1_000);
  const startedAt = new Date();
  const started = performance.now();
  const creationBlock = configuredCreationBlock ??
    await firstCodeBlock(discovery, report.target.address, report.blockNumber);

  if (indexedHolderPath) {
    const candidates = await readIndexedHolderCandidates(indexedHolderPath);
    const snapshotBlock = Number(BigInt(await state.call<string>("eth_blockNumber", [])));
    if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < report.blockNumber) {
      throw new Error("State RPC returned an invalid current block");
    }
    const [totalSupply, block, onchainBalances] = await Promise.all([
      readErc20Uint(state, report.target.address, "totalSupply", snapshotBlock),
      state.call<{ hash: string; timestamp: string }>("eth_getBlockByNumber", [ethers.toQuantity(snapshotBlock), false]),
      readBalances({
        rpc: state,
        contract: report.target.address,
        addresses: candidates.map((candidate) => candidate.address),
        blockNumber: snapshotBlock,
        concurrency
      })
    ]);
    const holders = candidates
      .map((candidate) => ({
        address: candidate.address,
        balance: onchainBalances.get(candidate.address.toLowerCase()) ?? 0n
      }))
      .filter((holder) => holder.balance > 0n)
      .sort((left, right) => left.balance === right.balance ? 0 : left.balance > right.balance ? -1 : 1);
    const balanceSum = holders.reduce((sum, holder) => sum + holder.balance, 0n);
    const sourceTotalSupply = report.facts.token?.totalSupply;
    const expectedSupply = typeof sourceTotalSupply === "string" ? BigInt(sourceTotalSupply) : undefined;
    if (balanceSum !== totalSupply || (expectedSupply !== undefined && expectedSupply !== totalSupply)) {
      throw new Error(
        `Indexed holder snapshot did not reconcile: candidates=${candidates.length}, positive=${holders.length}, balances=${balanceSum}, totalSupply=${totalSupply}, source=${expectedSupply ?? "unknown"}`
      );
    }
    const completedAt = new Date();
    const evidence = {
      version: 1,
      experimentId: "token-risk",
      evidenceKind: "complete-holder-snapshot",
      status: "measured",
      source: {
        missionId: typeof source.mission?.missionId === "string" ? source.mission.missionId : "unknown",
        evidenceFile: "paid-run-output.json",
        evidenceFileHash: sha256(sourceRaw),
        reportHash: tokenRiskReportHash(report),
        holderIndex: {
          provider: "BscScan Testnet",
          url: "https://testnet.bscscan.com/token/generic-tokenholders2?a=0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565&ps=100",
          observedAt: startedAt.toISOString(),
          indexedHolderCount: candidates.length,
          pageSize: 100,
          pagesRead: Math.ceil(candidates.length / 100),
          inputHash: sha256(await readFile(indexedHolderPath, "utf8"))
        }
      },
      target: {
        chainId: report.chainId,
        address: ethers.getAddress(report.target.address),
        snapshotBlock,
        snapshotBlockHash: block.hash,
        snapshotTimestamp: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
        contractCreationBlock: creationBlock
      },
      engine: {
        name: "agora-indexed-holder-snapshot",
        version: "1",
        method: "complete-indexed-holder-set-plus-block-locked-balance-reconciliation",
        indexProvider: "BscScan Testnet",
        stateEndpoint: state.endpoint,
        discoveryEndpoint: discovery.endpoint,
        creationBlockMethod: configuredCreationBlock === undefined
          ? "archive-code-binary-search"
          : "configured-archive-code-boundary",
        concurrency
      },
      snapshot: {
        totalSupplyRaw: totalSupply.toString(),
        indexedAddressCount: candidates.length,
        holderCount: holders.length,
        zeroBalanceIndexedAddresses: candidates.length - holders.length,
        holders: holders.map((holder, index) => ({
          rank: index + 1,
          address: holder.address,
          balanceRaw: holder.balance.toString(),
          sharePartsPerMillion: holderSharePartsPerMillion(holder.balance, totalSupply)
        })),
        concentration: {
          top1PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 1),
          top5PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 5),
          top10PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 10)
        }
      },
      validation: {
        method: "indexed-set-balance-sum-equals-total-supply",
        complete: true,
        candidateAddressCount: candidates.length,
        positiveBalanceCount: holders.length,
        blockBalanceSumRaw: balanceSum.toString(),
        totalSupplyRaw: totalSupply.toString(),
        sourceReportTotalSupplyRaw: expectedSupply?.toString(),
        balanceReadFailures: 0,
        missingSupplyRaw: "0",
        checks: [
          "Every address from all BscScan holder-index pages was read with balanceOf at one locked block.",
          "The sum of all positive indexed balances equals onchain totalSupply exactly.",
          "The onchain totalSupply is unchanged from the paid source report."
        ]
      },
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Number((performance.now() - started).toFixed(3))
      },
      limitations: [
        "Completeness relies on the BscScan holder index as the candidate set, then independently reconciles every candidate balance to onchain totalSupply at the locked block.",
        "The snapshot is exact for the locked snapshot block and does not claim that holder balances are unchanged afterward.",
        "Contract and exchange-controlled addresses are not de-duplicated by beneficial owner."
      ]
    };
    await mkdir(experimentDirectory, { recursive: true });
    await writeJsonAtomic(outputPath, evidence);
    console.log(JSON.stringify({
      outputPath,
      snapshotBlock,
      contractCreationBlock: creationBlock,
      indexedAddressCount: candidates.length,
      holderCount: holders.length,
      totalSupplyRaw: totalSupply.toString(),
      top1PartsPerMillion: evidence.snapshot.concentration.top1PartsPerMillion,
      complete: evidence.validation.complete,
      durationMs: evidence.timing.durationMs
    }, null, 2));
    return;
  }
  const cachedLogs = await readTransferLogCache({
    address: report.target.address,
    fromBlock: creationBlock,
    toBlock: report.blockNumber
  });
  const logs = cachedLogs ?? await scanTransferHistory({
      primary,
      fallback,
      address: report.target.address,
      from: creationBlock,
      to: report.blockNumber,
      chunkSize,
      concurrency
    });
  if (!cachedLogs) {
    await writeJsonAtomic(transferLogCachePath, {
      version: 1,
      target: ethers.getAddress(report.target.address),
      fromBlock: creationBlock,
      toBlock: report.blockNumber,
      transferTopic: ERC20_TRANSFER_TOPIC,
      logs
    });
  } else {
    console.error(`holder snapshot: reused ${logs.length} cached Transfer logs`);
  }
  const replay = replayHolderLedger(logs);
  const blockTag = ethers.toQuantity(report.blockNumber);
  const [totalSupply, block] = await Promise.all([
    readErc20Uint(state, report.target.address, "totalSupply", report.blockNumber),
    state.call<{ hash: string; timestamp: string }>("eth_getBlockByNumber", [blockTag, false])
  ]);

  const onchainBalances = new Map<string, bigint>();
  let balanceCursor = 0;
  async function balanceWorker(): Promise<void> {
    while (balanceCursor < replay.participantAddresses.length) {
      const address = replay.participantAddresses[balanceCursor++]!;
      const balance = await readErc20Uint(state, report.target.address, "balanceOf", report.blockNumber, [address]);
      onchainBalances.set(address.toLowerCase(), balance);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, replay.participantAddresses.length) }, () => balanceWorker()));
  const holders = replay.participantAddresses
    .map((address) => ({ address, balance: onchainBalances.get(address.toLowerCase()) ?? 0n }))
    .filter((holder) => holder.balance > 0n)
    .sort((left, right) => left.balance === right.balance ? 0 : left.balance > right.balance ? -1 : 1);
  const onchainBalanceSum = holders.reduce((sum, holder) => sum + holder.balance, 0n);
  const replayByAddress = new Map(replay.balances.map((holder) => [holder.address.toLowerCase(), holder.balance]));
  const mismatches = replay.participantAddresses.filter((address) =>
    (replayByAddress.get(address.toLowerCase()) ?? 0n) !== (onchainBalances.get(address.toLowerCase()) ?? 0n)
  );
  const sourceTotalSupply = report.facts.token?.totalSupply;
  const expectedSupply = typeof sourceTotalSupply === "string" ? BigInt(sourceTotalSupply) : undefined;
  const complete = replay.supply === totalSupply && onchainBalanceSum === totalSupply &&
    mismatches.length === 0 && (expectedSupply === undefined || expectedSupply === totalSupply);
  if (!complete) {
    throw new Error(
      `Holder snapshot did not reconcile: replay=${replay.supply}, balances=${onchainBalanceSum}, totalSupply=${totalSupply}, mismatches=${mismatches.length}`
    );
  }

  const completedAt = new Date();
  const evidence = {
    version: 1,
    experimentId: "token-risk",
    evidenceKind: "complete-holder-snapshot",
    status: "measured",
    source: {
      missionId: typeof source.mission?.missionId === "string" ? source.mission.missionId : "unknown",
      evidenceFile: "paid-run-output.json",
      evidenceFileHash: sha256(sourceRaw),
      reportHash: tokenRiskReportHash(report)
    },
    target: {
      chainId: report.chainId,
      address: ethers.getAddress(report.target.address),
      snapshotBlock: report.blockNumber,
      snapshotBlockHash: block.hash,
      snapshotTimestamp: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
      contractCreationBlock: creationBlock
    },
    engine: {
      name: "agora-transfer-ledger-holder-snapshot",
      version: "1",
      method: "complete-transfer-log-replay-plus-historical-balance-reconciliation",
      primaryEndpoint: primary.endpoint,
      fallbackEndpoint: fallback.endpoint,
      stateEndpoint: state.endpoint,
      discoveryEndpoint: discovery.endpoint,
      creationBlockMethod: configuredCreationBlock === undefined
        ? "archive-code-binary-search"
        : "configured-archive-code-boundary",
      chunkSize,
      concurrency
    },
    history: {
      fromBlock: creationBlock,
      toBlock: report.blockNumber,
      transferEvents: logs.length,
      participantAddresses: replay.participantAddresses.length,
      mintEvents: logs.filter((log) => log.topics[1]?.endsWith("0".repeat(40))).length,
      burnEvents: logs.filter((log) => log.topics[2]?.endsWith("0".repeat(40))).length,
      mintedRaw: replay.minted.toString(),
      burnedRaw: replay.burned.toString()
    },
    snapshot: {
      totalSupplyRaw: totalSupply.toString(),
      holderCount: holders.length,
      zeroBalanceParticipants: replay.participantAddresses.length - holders.length,
      holders: holders.map((holder, index) => ({
        rank: index + 1,
        address: holder.address,
        balanceRaw: holder.balance.toString(),
        sharePartsPerMillion: holderSharePartsPerMillion(holder.balance, totalSupply)
      })),
      concentration: {
        top1PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 1),
        top5PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 5),
        top10PartsPerMillion: topHolderSharePartsPerMillion(holders, totalSupply, 10)
      }
    },
    validation: {
      method: "transfer-ledger-replay-and-historical-balance-reconciliation",
      complete: true,
      reconstructedSupplyRaw: replay.supply.toString(),
      blockBalanceSumRaw: onchainBalanceSum.toString(),
      totalSupplyRaw: totalSupply.toString(),
      sourceReportTotalSupplyRaw: expectedSupply?.toString(),
      balanceReadFailures: 0,
      balanceMismatches: 0,
      missingSupplyRaw: "0",
      checks: [
        "Transfer logs scanned from the first contract-code block through the locked report block.",
        "Every participant balance was replayed and independently read with historical balanceOf at the locked block.",
        "The replayed supply, sum of nonzero balances, onchain totalSupply, and source report totalSupply are identical."
      ]
    },
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number((performance.now() - started).toFixed(3))
    },
    limitations: [
      "The snapshot is exact for the locked report block and does not claim that holder balances are unchanged afterward.",
      "Contract and exchange-controlled addresses are not de-duplicated by beneficial owner."
    ]
  };

  await mkdir(experimentDirectory, { recursive: true });
  await writeJsonAtomic(outputPath, evidence);
  console.log(JSON.stringify({
    outputPath,
    snapshotBlock: report.blockNumber,
    contractCreationBlock: creationBlock,
    transferEvents: logs.length,
    participantAddresses: replay.participantAddresses.length,
    holderCount: holders.length,
    totalSupplyRaw: totalSupply.toString(),
    top1PartsPerMillion: evidence.snapshot.concentration.top1PartsPerMillion,
    complete: evidence.validation.complete,
    durationMs: evidence.timing.durationMs
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
