import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OnchainRiskReport } from "@rebel/shared";
import { tokenRiskReportHash } from "../agents/hunter/src/security-pipeline.js";
import {
  createInvestigationRpc,
  type InvestigationRpc
} from "../agents/writer/src/investigation/onchain-investigator.js";
import {
  enrichTokenRiskWithPancakeLiquidity,
  summarizeErc20TransferWindow,
  type Erc20TransferLog,
  type Erc20TransferWindowSummary
} from "../agents/writer/src/investigation/token-risk-enrichment.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const sourcePath = path.join(experimentDirectory, "paid-run-output.json");
const outputPath = path.join(experimentDirectory, "indexed-enrichment-output.json");
const holderSnapshotPath = path.join(experimentDirectory, "holder-snapshot-output.json");
const sellabilityExecutionPath = path.join(experimentDirectory, "sellability-execution-output.json");
const envPath = path.join(repositoryRoot, ".env");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_RPC = "https://bsc-testnet-rpc.publicnode.com";

type AttemptStatus = "available" | "unavailable" | "payment-required" | "not-configured";

interface IndexedAttempt {
  source: "rpc-transfer-logs" | "bscscan-holder-index" | "etherscan-v2" | "blockscout";
  dimension: "holder-concentration" | "recent-transactions";
  endpoint: string;
  status: AttemptStatus;
  detail: string;
  observedRecords?: number;
  blockRange?: { from: number; to: number };
  activity?: Erc20TransferWindowSummary;
}

interface HolderSnapshotEvidence {
  version: 1;
  experimentId: "token-risk";
  evidenceKind: "complete-holder-snapshot";
  status: "measured";
  source: {
    missionId: string;
    reportHash: string;
    holderIndex?: { provider: string; url: string; indexedHolderCount: number };
  };
  target: { chainId: number; address: string; snapshotBlock: number };
  engine: { method: string; stateEndpoint: string };
  snapshot: {
    totalSupplyRaw: string;
    holderCount: number;
    concentration: {
      top1PartsPerMillion: number;
      top5PartsPerMillion: number;
      top10PartsPerMillion: number;
    };
  };
  validation: {
    complete: true;
    method: string;
    blockBalanceSumRaw: string;
    totalSupplyRaw: string;
    balanceReadFailures: 0;
    missingSupplyRaw: "0";
  };
  limitations: string[];
}

interface ReusableEnrichment {
  source?: { missionId?: string; reportHash?: string; blockNumber?: number; target?: string };
  dex?: Awaited<ReturnType<typeof enrichTokenRiskWithPancakeLiquidity>>;
  indexedData?: { attempts?: IndexedAttempt[] };
}

interface SellabilityExecutionEvidence {
  version: 1;
  evidenceKind: "executed-sellability-test";
  status: "confirmed";
  observedAt: string;
  chainId: number;
  input: { address: string; amountRaw: string };
  output: { amountRaw: string };
  route: { venue: "PancakeSwap V2"; pair: string };
  protection: { slippageBps: number; minimumOutRaw: string };
  balances: { routerAllowanceAfterSwapRaw: string };
  transactions: {
    exactApproval: { hash: string; blockNumber: number };
    swap: { hash: string; blockNumber: number };
  };
  interpretation: string;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function boundHolderSnapshot(
  evidence: HolderSnapshotEvidence | undefined,
  report: OnchainRiskReport,
  missionId: string,
  reportHash: string
): HolderSnapshotEvidence | undefined {
  if (!evidence) return undefined;
  const valid = evidence.version === 1 &&
    evidence.experimentId === "token-risk" &&
    evidence.evidenceKind === "complete-holder-snapshot" &&
    evidence.status === "measured" &&
    evidence.source.missionId === missionId &&
    evidence.source.reportHash === reportHash &&
    evidence.target.chainId === report.chainId &&
    evidence.target.address.toLowerCase() === report.target.address.toLowerCase() &&
    evidence.target.snapshotBlock >= report.blockNumber &&
    evidence.validation.complete === true &&
    evidence.validation.balanceReadFailures === 0 &&
    evidence.validation.missingSupplyRaw === "0" &&
    evidence.validation.blockBalanceSumRaw === evidence.snapshot.totalSupplyRaw &&
    evidence.validation.totalSupplyRaw === evidence.snapshot.totalSupplyRaw &&
    evidence.snapshot.totalSupplyRaw === report.facts.token?.totalSupply;
  if (!valid) throw new Error("holder-snapshot-output.json is not bound to the paid token-risk report");
  return evidence;
}

function boundSellabilityExecution(
  evidence: SellabilityExecutionEvidence | undefined,
  report: OnchainRiskReport
): SellabilityExecutionEvidence | undefined {
  if (!evidence) return undefined;
  const valid = evidence.version === 1 &&
    evidence.evidenceKind === "executed-sellability-test" &&
    evidence.status === "confirmed" &&
    evidence.chainId === report.chainId &&
    evidence.input.address.toLowerCase() === report.target.address.toLowerCase() &&
    evidence.route.venue === "PancakeSwap V2" &&
    /^0x[0-9a-fA-F]{64}$/.test(evidence.transactions.exactApproval.hash) &&
    /^0x[0-9a-fA-F]{64}$/.test(evidence.transactions.swap.hash) &&
    evidence.transactions.swap.blockNumber >= report.blockNumber &&
    BigInt(evidence.input.amountRaw) > 0n &&
    BigInt(evidence.output.amountRaw) > 0n &&
    BigInt(evidence.output.amountRaw) >= BigInt(evidence.protection.minimumOutRaw) &&
    evidence.balances.routerAllowanceAfterSwapRaw === "0";
  if (!valid) throw new Error("sellability-execution-output.json is incomplete or targets a different token");
  return evidence;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function parseEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

function safeProviderDetail(raw: unknown): string {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value.includes("free api access is not supported")) {
    return "BSC testnet access is not included in the configured free API tier.";
  }
  if (value.includes("deprecated v1")) {
    return "The legacy explorer API is deprecated.";
  }
  if (value.includes("rate limit")) {
    return "The provider rate limit was reached.";
  }
  return "The provider did not return a usable indexed dataset.";
}

async function probeRpcTransferLogs(
  rpc: InvestigationRpc,
  report: OnchainRiskReport
): Promise<IndexedAttempt> {
  const from = Math.max(0, report.blockNumber - 10_000);
  try {
    const logs = await rpc.call<Erc20TransferLog[]>("eth_getLogs", [{
      address: report.target.address,
      topics: [TRANSFER_TOPIC],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${report.blockNumber.toString(16)}`
    }]);
    return {
      source: "rpc-transfer-logs",
      dimension: "recent-transactions",
      endpoint: rpc.endpoint,
      status: "available",
      detail: "A bounded 10,000-block Transfer log window was returned.",
      observedRecords: logs.length,
      blockRange: { from, to: report.blockNumber },
      activity: summarizeErc20TransferWindow(logs)
    };
  } catch {
    return {
      source: "rpc-transfer-logs",
      dimension: "recent-transactions",
      endpoint: rpc.endpoint,
      status: "unavailable",
      detail: "The public RPC serves historical state at the report block but has pruned its Transfer log history for this window.",
      blockRange: { from, to: report.blockNumber }
    };
  }
}

async function probeEtherscan(input: {
  apiKey?: string;
  report: OnchainRiskReport;
  dimension: IndexedAttempt["dimension"];
}): Promise<IndexedAttempt> {
  const endpoint = "https://api.etherscan.io";
  if (!input.apiKey) {
    return {
      source: "etherscan-v2",
      dimension: input.dimension,
      endpoint,
      status: "not-configured",
      detail: "No Etherscan-compatible API key is configured."
    };
  }
  const parameters = new URLSearchParams({
    chainid: "97",
    module: input.dimension === "holder-concentration" ? "token" : "account",
    action: input.dimension === "holder-concentration" ? "tokenholderlist" : "tokentx",
    contractaddress: input.report.target.address,
    page: "1",
    offset: "100",
    apikey: input.apiKey
  });
  if (input.dimension === "recent-transactions") {
    parameters.set("address", input.report.target.address);
    parameters.set("startblock", "0");
    parameters.set("endblock", String(input.report.blockNumber));
    parameters.set("sort", "desc");
  }
  try {
    const response = await fetch(`https://api.etherscan.io/v2/api?${parameters}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json() as {
      status?: unknown;
      message?: unknown;
      result?: unknown;
    };
    if (response.ok && payload.status === "1" && Array.isArray(payload.result)) {
      return {
        source: "etherscan-v2",
        dimension: input.dimension,
        endpoint,
        status: "available",
        detail: "The configured explorer tier returned the first indexed page; complete pagination is still required before concentration claims.",
        observedRecords: payload.result.length
      };
    }
    return {
      source: "etherscan-v2",
      dimension: input.dimension,
      endpoint,
      status: "unavailable",
      detail: safeProviderDetail(payload.result ?? payload.message)
    };
  } catch {
    return {
      source: "etherscan-v2",
      dimension: input.dimension,
      endpoint,
      status: "unavailable",
      detail: "The explorer request failed without yielding indexed evidence."
    };
  }
}

async function probeBlockscout(
  report: OnchainRiskReport,
  dimension: IndexedAttempt["dimension"]
): Promise<IndexedAttempt> {
  const endpoint = "https://api.blockscout.com";
  const suffix = dimension === "holder-concentration" ? "holders" : "transfers";
  try {
    const response = await fetch(
      `${endpoint}/97/api/v2/tokens/${report.target.address}/${suffix}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
    );
    if (response.status === 402) {
      return {
        source: "blockscout",
        dimension,
        endpoint,
        status: "payment-required",
        detail: "The chain-97 index requires an API key or a new x402 payment; neither was authorized for this post-run enrichment."
      };
    }
    const payload = await response.json() as { items?: unknown[] };
    if (response.ok && Array.isArray(payload.items)) {
      return {
        source: "blockscout",
        dimension,
        endpoint,
        status: "available",
        detail: "The provider returned an indexed page; complete pagination is still required before concentration claims.",
        observedRecords: payload.items.length
      };
    }
    return {
      source: "blockscout",
      dimension,
      endpoint,
      status: "unavailable",
      detail: "The provider did not return a usable indexed page."
    };
  } catch {
    return {
      source: "blockscout",
      dimension,
      endpoint,
      status: "unavailable",
      detail: "The provider request failed without yielding indexed evidence."
    };
  }
}

async function main(): Promise<void> {
  const [sourceRaw, envRaw, holderSnapshotRaw, sellabilityExecutionRaw, reusableRaw] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(envPath, "utf8").catch(() => ""),
    readOptionalJson<HolderSnapshotEvidence>(holderSnapshotPath),
    readOptionalJson<SellabilityExecutionEvidence>(sellabilityExecutionPath),
    readOptionalJson<ReusableEnrichment>(outputPath)
  ]);
  const source = JSON.parse(sourceRaw) as {
    mission?: { missionId?: unknown };
    report?: OnchainRiskReport;
  };
  if (!source.report || source.report.version !== 1) {
    throw new Error("paid-run-output.json does not contain a version-1 token-risk report");
  }
  const env = parseEnv(envRaw);
  const endpoint = process.env.TOKEN_RISK_ENRICHMENT_RPC_URL || DEFAULT_RPC;
  const rpc = createInvestigationRpc({ endpoint, timeoutMs: 15_000, attempts: 2 });
  const startedAt = new Date();
  const started = performance.now();
  const missionId = typeof source.mission?.missionId === "string" ? source.mission.missionId : "unknown";
  const reportHash = tokenRiskReportHash(source.report);
  const reusableValid = reusableRaw?.source?.missionId === missionId &&
    reusableRaw.source.reportHash === reportHash &&
    reusableRaw.source.blockNumber === source.report.blockNumber &&
    reusableRaw.source.target?.toLowerCase() === source.report.target.address.toLowerCase() &&
    reusableRaw.dex?.blockNumber === source.report.blockNumber &&
    reusableRaw.dex.target.toLowerCase() === source.report.target.address.toLowerCase() &&
    reusableRaw.dex.engine.method === "historical-eth-call";
  let reusedImmutableEvidence = process.env.TOKEN_RISK_ENRICHMENT_REUSE_IMMUTABLE === "true";
  let dex: Awaited<ReturnType<typeof enrichTokenRiskWithPancakeLiquidity>>;
  if (reusedImmutableEvidence) {
    if (!reusableValid || !reusableRaw?.dex) {
      throw new Error("No valid immutable enrichment evidence is available to reuse");
    }
    dex = reusableRaw.dex;
  } else {
    try {
      dex = await enrichTokenRiskWithPancakeLiquidity(source.report, {
        rpc,
        now: () => new Date()
      });
    } catch (error) {
      if (!reusableValid || !reusableRaw?.dex) throw error;
      console.error("token-risk enrichment: current RPC cannot replay the locked block; reusing hash-bound immutable DEX evidence");
      dex = reusableRaw.dex;
      reusedImmutableEvidence = true;
    }
  }
  const apiKey = process.env.ETHERSCAN_API_KEY || env.ETHERSCAN_API_KEY ||
    process.env.BSCSCAN_API_KEY || env.BSCSCAN_API_KEY;
  const attempts = reusedImmutableEvidence && Array.isArray(reusableRaw?.indexedData?.attempts)
    ? reusableRaw.indexedData.attempts
    : await Promise.all([
        probeRpcTransferLogs(rpc, source.report),
        probeEtherscan({ apiKey, report: source.report, dimension: "holder-concentration" }),
        probeEtherscan({ apiKey, report: source.report, dimension: "recent-transactions" }),
        probeBlockscout(source.report, "holder-concentration"),
        probeBlockscout(source.report, "recent-transactions")
      ]);
  const completedAt = new Date();
  const coverageValues = Object.values(source.report.coverage);
  const originalMeasured = coverageValues.filter((status) => status === "measured").length;
  const holderSnapshot = boundHolderSnapshot(holderSnapshotRaw, source.report, missionId, reportHash);
  const sellabilityExecution = boundSellabilityExecution(sellabilityExecutionRaw, source.report);
  const recentRpc = attempts.find((attempt) =>
    attempt.source === "rpc-transfer-logs" && attempt.status === "available"
  );
  const indexedAttempts = holderSnapshot ? [
    {
      source: "bscscan-holder-index" as const,
      dimension: "holder-concentration" as const,
      endpoint: holderSnapshot.source.holderIndex?.url ?? "https://testnet.bscscan.com/token/tokenholderchart",
      status: "available" as const,
      detail: `${holderSnapshot.snapshot.holderCount} indexed balances were read at block ${holderSnapshot.target.snapshotBlock} and reconciled exactly to totalSupply.`,
      observedRecords: holderSnapshot.snapshot.holderCount,
      blockRange: {
        from: source.report.blockNumber,
        to: source.report.blockNumber
      }
    },
    ...attempts
  ] : attempts;
  const enrichedDex = sellabilityExecution ? {
    ...dex,
    coverage: { liquidity: "measured" as const, sellability: "measured" as const },
    limitations: dex.limitations.filter((limitation) =>
      !limitation.startsWith("A router quote is not an executed transfer")
    )
  } : dex;
  const postRunMeasured = Math.min(
    coverageValues.length,
    originalMeasured + 1 + Number(Boolean(recentRpc)) + Number(Boolean(holderSnapshot))
  );
  const evidence = {
    version: 1,
    experimentId: "token-risk",
    enrichmentKind: "post-run-index-and-dex-enrichment",
    settlement: {
      status: "not-paid",
      reason: "Read-only post-run enrichment; payment-required indexers were not called with payment credentials."
    },
    source: {
      missionId,
      evidenceFile: "paid-run-output.json",
      reportHash,
      blockNumber: source.report.blockNumber,
      target: source.report.target.address
    },
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number((performance.now() - started).toFixed(3))
    },
    dex: enrichedDex,
    indexedData: {
      holderConcentration: holderSnapshot ? {
        status: "measured",
        evidenceFile: "holder-snapshot-output.json",
        snapshotBlock: holderSnapshot.target.snapshotBlock,
        holderCount: holderSnapshot.snapshot.holderCount,
        totalSupplyRaw: holderSnapshot.snapshot.totalSupplyRaw,
        ...holderSnapshot.snapshot.concentration,
        validation: holderSnapshot.validation
      } : {
        status: "unavailable",
        reason: "No complete, block-locked holder snapshot reconciled to total supply."
      },
      recentTransactions: recentRpc ? {
        status: "measured",
        observedTransfers: recentRpc.observedRecords ?? 0,
        blockRange: recentRpc.blockRange,
        activity: recentRpc.activity
      } : {
        status: "unavailable",
        reason: "Historical Transfer logs and free testnet explorer indexing were unavailable."
      },
      attempts: indexedAttempts
    },
    ...(sellabilityExecution ? {
      sellabilityExecution: {
        status: "confirmed",
        evidenceFile: "sellability-execution-output.json",
        observedAt: sellabilityExecution.observedAt,
        blockNumber: sellabilityExecution.transactions.swap.blockNumber,
        venue: sellabilityExecution.route.venue,
        inputAmountRaw: sellabilityExecution.input.amountRaw,
        outputAmountRaw: sellabilityExecution.output.amountRaw,
        slippageBps: sellabilityExecution.protection.slippageBps,
        minimumOutRaw: sellabilityExecution.protection.minimumOutRaw,
        approvalTransaction: sellabilityExecution.transactions.exactApproval.hash,
        swapTransaction: sellabilityExecution.transactions.swap.hash,
        routerAllowanceAfterSwapRaw: "0"
      }
    } : {}),
    coverage: {
      originalMeasured,
      postRunMeasured,
      total: coverageValues.length,
      added: [
        "liquidity",
        ...(sellabilityExecution ? ["sellabilityExecution"] : []),
        ...(recentRpc ? ["recentTransactions"] : []),
        ...(holderSnapshot ? ["holderConcentration"] : [])
      ],
      partial: sellabilityExecution ? [] : ["sellability-quote"],
      unavailable: [
        ...(!holderSnapshot ? ["holderConcentration"] : []),
        ...(!recentRpc ? ["recentTransactions"] : [])
      ]
    },
    limitations: [
      ...enrichedDex.limitations,
      ...(holderSnapshot ? holderSnapshot.limitations : [
        "Holder concentration remains unavailable until a complete indexed snapshot can be obtained and validated against total supply."
      ]),
      ...(sellabilityExecution ? [
        "The executed sellability test proves the recorded 0.1 U route at its transaction block, not unlimited sellability or future liquidity."
      ] : []),
      ...(!recentRpc
        ? ["Recent Transfer behavior remains unavailable because every non-paid historical index path was blocked or pruned."]
        : []),
      ...(reusedImmutableEvidence
        ? ["The report-block DEX and recent-transaction evidence is immutable, hash-bound evidence reused after public RPC pruning; the new holder snapshot was independently read at its own locked block."]
        : [])
    ]
  };

  await mkdir(experimentDirectory, { recursive: true });
  await writeJsonAtomic(outputPath, evidence);
  console.log(JSON.stringify({
    outputPath,
    reportHash: evidence.source.reportHash,
    blockNumber: evidence.source.blockNumber,
    v2Pair: dex.v2.pair,
    v2ReserveTokenRaw: dex.v2.reserveTokenRaw,
    v2ReserveWrappedNativeRaw: dex.v2.reserveWrappedNativeRaw,
    activeV3Pools: enrichedDex.v3.pools.filter((pool) => BigInt(pool.liquidityRaw ?? "0") > 0n).length,
    quoteStatus: enrichedDex.quote.status,
    sellabilityStatus: enrichedDex.coverage.sellability,
    holderConcentrationStatus: holderSnapshot ? "measured" : "unavailable",
    coverage: evidence.coverage,
    durationMs: evidence.timing.durationMs
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
