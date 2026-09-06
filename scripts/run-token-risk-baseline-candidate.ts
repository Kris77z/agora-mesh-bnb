import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInvestigationRpc } from "../agents/writer/src/investigation/onchain-investigator.js";
import { runOrdinaryBaselineModel } from "../agents/writer/src/ordinary-baseline-runner.js";
import { writerConfig } from "../agents/writer/src/config.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const inputPath = path.join(experimentDirectory, "baseline-input.json");
const rpcRawPath = path.join(experimentDirectory, "baseline-rpc-raw.json");
const modelRawPath = path.join(experimentDirectory, "baseline-model-raw.json");
const candidatePath = path.join(experimentDirectory, "baseline-output-candidate.json");

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const CALLS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
  getOwner: "0x893d20e8"
} as const;

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function parseHexQuantity(value: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("invalid hex quantity");
  return BigInt(value).toString();
}

function decodeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("invalid address ABI word");
  return `0x${value.slice(-40)}`.toLowerCase();
}

function decodeString(value: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("invalid string ABI value");
  const hex = value.slice(2);
  if (hex.length === 64) {
    return Buffer.from(hex.replace(/(00)+$/, ""), "hex").toString("utf8");
  }
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
  const lengthOffset = offset * 2;
  const length = Number(BigInt(`0x${hex.slice(lengthOffset, lengthOffset + 64)}`));
  const dataStart = lengthOffset + 64;
  return Buffer.from(hex.slice(dataStart, dataStart + length * 2), "hex").toString("utf8");
}

function parseJsonCandidate(raw: string): unknown {
  const trimmed = raw.trim();
  return JSON.parse(trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim()
    : trimmed);
}

async function main(): Promise<void> {
  const input = JSON.parse(await readFile(inputPath, "utf8")) as {
    version?: unknown;
    experimentId?: unknown;
    status?: unknown;
    task?: unknown;
    taskHash?: unknown;
    bindings?: { chainId?: unknown; target?: unknown; reportBlock?: unknown };
  };
  if (
    input.version !== 1 ||
    input.experimentId !== "token-risk" ||
    input.status !== "ready-for-blind-execution" ||
    typeof input.task !== "string" ||
    input.taskHash !== sha256(input.task) ||
    input.bindings?.chainId !== 97 ||
    typeof input.bindings.target !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.bindings.target) ||
    !Number.isSafeInteger(input.bindings.reportBlock)
  ) {
    throw new Error("Experiment 2 baseline input is not locked to the expected task, chain, target, and block");
  }
  const target = input.bindings.target;
  const reportBlock = input.bindings.reportBlock as number;
  const rpc = createInvestigationRpc({
    endpoint: writerConfig.riskVerifier.rpcUrl,
    timeoutMs: writerConfig.investigator.rpcTimeoutMs,
    attempts: writerConfig.investigator.rpcAttempts
  });
  const startedAt = new Date();
  const started = performance.now();
  const latestHex = await rpc.call<string>("eth_blockNumber", []);
  const latestBlock = Number(BigInt(latestHex));

  const observe = async (
    label: string,
    blockNumber: number,
    method: string,
    params: unknown[],
    decode: (value: string) => unknown = (value) => value
  ) => {
    try {
      const raw = await rpc.call<string>(method, params);
      return { label, blockNumber, status: "measured" as const, value: decode(raw) };
    } catch (error) {
      return {
        label,
        blockNumber,
        status: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  };
  const observations: Array<Record<string, unknown>> = [];
  for (const blockNumber of [reportBlock, latestBlock]) {
    const blockTag = `0x${blockNumber.toString(16)}`;
    const reads = await Promise.all([
      observe("nativeBalanceWei", blockNumber, "eth_getBalance", [target, blockTag], parseHexQuantity),
      observe("transactionCount", blockNumber, "eth_getTransactionCount", [target, blockTag], parseHexQuantity),
      observe("bytecode", blockNumber, "eth_getCode", [target, blockTag], (value) => ({
        byteLength: Math.max(0, (value.length - 2) / 2),
        contentHash: sha256(value),
        capabilitySelectors: {
          mint: /40c10f19|a0712d68/i.test(value),
          pause: /8456cb59/i.test(value),
          upgrade: /3659cfe6|4f1ef286/i.test(value)
        }
      })),
      observe("name", blockNumber, "eth_call", [{ to: target, data: CALLS.name }, blockTag], decodeString),
      observe("symbol", blockNumber, "eth_call", [{ to: target, data: CALLS.symbol }, blockTag], decodeString),
      observe("decimals", blockNumber, "eth_call", [{ to: target, data: CALLS.decimals }, blockTag], parseHexQuantity),
      observe("totalSupply", blockNumber, "eth_call", [{ to: target, data: CALLS.totalSupply }, blockTag], parseHexQuantity),
      observe("owner", blockNumber, "eth_call", [{ to: target, data: CALLS.owner }, blockTag], decodeAddress),
      observe("getOwner", blockNumber, "eth_call", [{ to: target, data: CALLS.getOwner }, blockTag], decodeAddress),
      observe("eip1967Implementation", blockNumber, "eth_getStorageAt", [target, IMPLEMENTATION_SLOT, blockTag], decodeAddress),
      observe("eip1967Admin", blockNumber, "eth_getStorageAt", [target, ADMIN_SLOT, blockTag], decodeAddress)
    ]);
    observations.push(...reads);
  }
  const completedAt = new Date();
  const rpcEvidence = {
    version: 1,
    experimentId: "token-risk",
    workflow: "direct-read-only-rpc-baseline-candidate",
    settlement: { status: "not-paid", reason: "Only allowlisted read-only JSON-RPC methods were used." },
    inputBundle: "baseline-input.json",
    inputBundleHash: sha256(await readFile(inputPath)),
    taskHash: input.taskHash,
    chainId: 97,
    target,
    reportBlock,
    latestBlock,
    endpoint: rpc.endpoint,
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number((performance.now() - started).toFixed(3))
    },
    observations,
    limitations: [
      "Historical state failures are retained as unavailable and are not replaced by latest-state claims.",
      "This direct RPC capture does not provide complete holder concentration, all-DEX liquidity, or executed sellability evidence."
    ]
  };
  await writeJsonAtomic(rpcRawPath, rpcEvidence);

  const system = [
    "You are a general-purpose token-risk analyst working without multi-agent orchestration.",
    "Use only the supplied locked task and direct read-only RPC observations.",
    "Keep historical-unavailable and latest-state evidence separate. Do not invent holder, liquidity, or sellability facts.",
    "Return JSON only with facts, riskSignals, coverage, recommendation, and limitations.",
    "Every fact must include claim, status (measured/unavailable), source, and observationBlock."
  ].join("\n");
  const modelInput = {
    task: input.task,
    chainId: 97,
    target,
    requiredComparisonBlock: reportBlock,
    directRpcEvidence: rpcEvidence
  };
  const prompt = JSON.stringify(modelInput);
  const modelStartedAt = new Date();
  const modelStarted = performance.now();
  const response = await runOrdinaryBaselineModel({
    system,
    prompt,
    model: process.env.BASELINE_MODEL?.trim()
  });
  const modelCompletedAt = new Date();
  const modelEvidence = {
    version: 1,
    experimentId: "token-risk",
    workflow: "ordinary-llm-direct-model-only",
    status: "frozen-before-agent-report-comparison",
    inputBundleHash: rpcEvidence.inputBundleHash,
    rpcArtifact: "baseline-rpc-raw.json",
    rpcArtifactHash: sha256(await readFile(rpcRawPath)),
    model: { provider: response.provider, model: response.model, sessionCount: 1 },
    timing: {
      startedAt: modelStartedAt.toISOString(),
      completedAt: modelCompletedAt.toISOString(),
      wallDurationMs: Number((performance.now() - modelStarted).toFixed(3)),
      operatorActiveMinutes: 0,
      operatorType: "automated-codex-orchestrator"
    },
    usage: response.usage,
    prompts: { system, user: prompt },
    rawOutput: response.text,
    blindness: {
      llmContextExcludedAgentOutputs: true,
      llmContextExcludedGroundTruth: true,
      operatorWasIndependentHuman: false,
      operatorHadPriorProjectContext: true
    }
  };
  await writeJsonAtomic(modelRawPath, modelEvidence);
  const report = parseJsonCandidate(response.text);
  await writeJsonAtomic(candidatePath, {
    version: 1,
    experimentId: "token-risk",
    workflow: "without-agent-ordinary-llm-plus-direct-rpc-candidate",
    status: "non-blind-operator-candidate",
    input: {
      bundle: "baseline-input.json",
      bundleHash: rpcEvidence.inputBundleHash,
      taskHash: input.taskHash,
      chainId: 97,
      target,
      reportBlock
    },
    rawEvidence: {
      rpcArtifact: "baseline-rpc-raw.json",
      rpcArtifactHash: modelEvidence.rpcArtifactHash,
      modelArtifact: "baseline-model-raw.json",
      modelArtifactHash: sha256(await readFile(modelRawPath)),
      frozenBeforeAgentReportComparison: true
    },
    timing: {
      rpcDurationMs: rpcEvidence.timing.durationMs,
      modelDurationMs: modelEvidence.timing.wallDurationMs,
      totalWallDurationMs: Number((rpcEvidence.timing.durationMs + modelEvidence.timing.wallDurationMs).toFixed(3)),
      operatorActiveMinutes: 0,
      operatorType: "automated-codex-orchestrator"
    },
    model: modelEvidence.model,
    usage: modelEvidence.usage,
    cost: {
      modelUsd: null,
      toolUsd: 0,
      humanUsd: null,
      totalUsd: null,
      basis: "Provider token usage is captured; invoice pricing and independent human labor were unavailable."
    },
    report,
    comparisonEligibility: {
      controlledBaseline: false,
      reason: "The model context excluded Agent conclusions, but the orchestrator was not an independent human and had prior project context."
    },
    limitations: [
      ...rpcEvidence.limitations,
      "This is a model-plus-direct-RPC candidate, not the plan's independent human controlled baseline.",
      "No post-freeze independent quality review has been recorded."
    ]
  });
  process.stdout.write(`${JSON.stringify({
    candidatePath: path.relative(repositoryRoot, candidatePath),
    model: response.model,
    rpcDurationMs: rpcEvidence.timing.durationMs,
    modelDurationMs: modelEvidence.timing.wallDurationMs,
    usage: response.usage,
    historicalMeasured: observations.filter((item) => item.blockNumber === reportBlock && item.status === "measured").length,
    historicalUnavailable: observations.filter((item) => item.blockNumber === reportBlock && item.status === "unavailable").length,
    controlledBaseline: false
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Token-risk baseline candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
