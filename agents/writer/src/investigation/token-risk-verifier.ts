import { createHash } from "node:crypto";
import type {
  OnchainRiskReport,
  TokenRiskVerificationCheck,
  TokenRiskVerificationReport
} from "@rebel/shared";
import { writerConfig } from "../config.js";
import { parseOnchainRiskReport } from "../structured-output.js";
import {
  createInvestigationRpc,
  investigateOnchainTarget,
  type InvestigationRpc
} from "./onchain-investigator.js";

export interface TokenRiskVerificationDependencies {
  rpc: InvestigationRpc;
  chainId: number;
  now(): Date;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticHash(report: OnchainRiskReport): string {
  return `sha256:${createHash("sha256").update(stableJson(report)).digest("hex")}`;
}

function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
}

function comparisonCheck(
  id: string,
  expectedValue: unknown,
  actualValue: unknown,
  evidence: string
): TokenRiskVerificationCheck {
  const expected = stableJson(expectedValue);
  const actual = stableJson(actualValue);
  return {
    id,
    status: expected === actual ? "confirmed" : "mismatch",
    expected,
    actual,
    evidence
  };
}

function parseInput(rawInput: string): OnchainRiskReport {
  let value: unknown;
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    value = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      "report" in parsed
      ? (parsed as { report?: unknown }).report
      : parsed;
  } catch {
    throw new Error("Token-risk verification input must be a JSON report or { report } object");
  }
  return parseOnchainRiskReport(value);
}

export async function verifyTokenRiskReport(
  rawInput: string,
  deps: TokenRiskVerificationDependencies
): Promise<TokenRiskVerificationReport> {
  const report = parseInput(rawInput);
  if (report.chainId !== deps.chainId) {
    throw new Error(
      `Report chain ${report.chainId} does not match verifier chain ${deps.chainId}`
    );
  }
  const replay = await investigateOnchainTarget(
    JSON.stringify({ address: report.target.address, chainId: report.chainId }),
    {
      chainId: deps.chainId,
      rpc: deps.rpc,
      now: deps.now,
      blockNumber: report.blockNumber
    }
  );
  const checks: TokenRiskVerificationCheck[] = [
    comparisonCheck(
      "target-runtime",
      report.target,
      replay.target,
      `Replayed eth_getCode at block ${report.blockNumber}.`
    ),
    comparisonCheck(
      "account-state",
      {
        nativeBalanceWei: report.facts.nativeBalanceWei,
        transactionCount: report.facts.transactionCount
      },
      {
        nativeBalanceWei: replay.facts.nativeBalanceWei,
        transactionCount: replay.facts.transactionCount
      },
      `Replayed eth_getBalance and eth_getTransactionCount at block ${report.blockNumber}.`
    ),
    comparisonCheck(
      "token-metadata",
      report.facts.token,
      replay.facts.token,
      `Replayed ERC-20 metadata calls at block ${report.blockNumber}.`
    ),
    comparisonCheck(
      "ownership",
      report.facts.ownership,
      replay.facts.ownership,
      `Replayed owner()/getOwner() probes at block ${report.blockNumber}.`
    ),
    comparisonCheck(
      "proxy-control",
      report.facts.proxy,
      replay.facts.proxy,
      `Replayed EIP-1967 slots and implementation bytecode at block ${report.blockNumber}.`
    ),
    comparisonCheck(
      "risk-signals",
      report.riskSignals,
      replay.riskSignals,
      "Recomputed selector and opcode signals from independently fetched runtime bytecode."
    ),
    comparisonCheck(
      "risk-score",
      report.riskScore,
      replay.riskScore,
      "Recomputed the deterministic weighted risk score."
    ),
    comparisonCheck(
      "risk-level",
      report.riskLevel,
      replay.riskLevel,
      "Recomputed the score-to-level threshold classification."
    ),
    comparisonCheck(
      "coverage",
      report.coverage,
      replay.coverage,
      "Checked that measured and explicitly unmeasured dimensions were preserved."
    ),
    comparisonCheck(
      "limitations",
      report.limitations,
      replay.limitations,
      "Checked that unsupported dimensions were not silently promoted to measured facts."
    ),
    comparisonCheck(
      "recommendation",
      report.recommendation,
      replay.recommendation,
      "Recomputed the deterministic recommendation threshold."
    )
  ];
  const summary = {
    confirmed: checks.filter((check) => check.status === "confirmed").length,
    mismatched: checks.filter((check) => check.status === "mismatch").length,
    unavailable: checks.filter((check) => check.status === "unavailable").length,
    total: checks.length
  };
  const sourceEndpoint = publicEndpoint(report.sources[0]?.endpoint ?? "unknown");
  const verifierEndpoint = publicEndpoint(deps.rpc.endpoint);
  const independentTransport = sourceEndpoint !== verifierEndpoint;
  const status = summary.mismatched > 0
    ? "rejected"
    : summary.unavailable > 0 || !independentTransport
      ? "partial"
      : "confirmed";
  return {
    version: 1,
    chainId: report.chainId,
    target: report.target.address,
    sourceReportHash: semanticHash(report),
    sourceObservedAt: report.observedAt,
    verifiedAt: deps.now().toISOString(),
    blockNumber: report.blockNumber,
    engine: {
      method: "independent-rpc-replay",
      name: "agora-token-risk-verifier",
      version: "1",
      endpoint: verifierEndpoint,
      independentTransport
    },
    checks,
    summary,
    conclusion: {
      status,
      originalRiskScore: report.riskScore,
      replayedRiskScore: replay.riskScore,
      originalRiskLevel: report.riskLevel,
      replayedRiskLevel: replay.riskLevel
    },
    limitations: [
      "The verifier replays deterministic RPC facts and scoring only; it does not convert unmeasured holder, liquidity, sellability, or transaction dimensions into facts.",
      ...(independentTransport
        ? []
        : ["The verifier used the same public RPC transport origin as the source report."])
    ]
  };
}

export function runProductionTokenRiskVerification(
  taskInput: string
): Promise<TokenRiskVerificationReport> {
  return verifyTokenRiskReport(taskInput, {
    chainId: writerConfig.chainId,
    now: () => new Date(),
    rpc: createInvestigationRpc({
      endpoint: writerConfig.riskVerifier.rpcUrl,
      timeoutMs: writerConfig.investigator.rpcTimeoutMs,
      attempts: writerConfig.investigator.rpcAttempts
    })
  });
}
