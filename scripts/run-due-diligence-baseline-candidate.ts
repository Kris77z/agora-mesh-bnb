import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SecurityTaskInput } from "@rebel/shared";
import { runOrdinaryBaselineModel } from "../agents/writer/src/ordinary-baseline-runner.js";
import { runSlitherAnalysis } from "../agents/writer/src/verification/slither-runner.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-3-due-diligence");
const tokenRiskDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const artifactSuffix = process.env.BASELINE_ARTIFACT_SUFFIX?.trim() ?? "";
if (artifactSuffix && !/^-attempt-[1-9]\d*$/.test(artifactSuffix)) {
  throw new Error("BASELINE_ARTIFACT_SUFFIX must be empty or use -attempt-N");
}
const inputPath = path.join(experimentDirectory, "baseline-input.json");
const sourcePath = path.join(experimentDirectory, "verified-source-input.json");
const rpcPath = path.join(tokenRiskDirectory, "baseline-rpc-raw.json");
const slitherArtifactName = `baseline-slither-output${artifactSuffix}.json`;
const modelArtifactName = `baseline-model-raw${artifactSuffix}.json`;
const candidateArtifactName = `baseline-output-candidate${artifactSuffix}.json`;
const slitherPath = path.join(experimentDirectory, slitherArtifactName);
const modelRawPath = path.join(experimentDirectory, modelArtifactName);
const candidatePath = path.join(experimentDirectory, candidateArtifactName);

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function parseJsonCandidate(raw: string): unknown {
  const trimmed = raw.trim();
  return JSON.parse(trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim()
    : trimmed);
}

function combinedFirstPartySource(sources: Record<string, string>, sourceUnits: readonly string[]): string {
  return [...sourceUnits]
    .sort((left, right) => left.localeCompare(right))
    .map((sourceUnit) => `// ===== Source unit: ${sourceUnit} =====\n${sources[sourceUnit]!.trimEnd()}`)
    .join("\n\n");
}

async function main(): Promise<void> {
  const [inputRaw, sourceRaw, rpcRaw] = await Promise.all([
    readFile(inputPath),
    readFile(sourcePath),
    readFile(rpcPath)
  ]);
  const input = JSON.parse(inputRaw.toString("utf8")) as {
    version?: unknown;
    experimentId?: unknown;
    status?: unknown;
    task?: unknown;
    taskHash?: unknown;
    bindings?: {
      chainId?: unknown;
      proxy?: unknown;
      implementation?: unknown;
      sourceHash?: unknown;
      reportBlock?: unknown;
    };
  };
  const securityInput = JSON.parse(sourceRaw.toString("utf8")) as SecurityTaskInput;
  const rpcEvidence = JSON.parse(rpcRaw.toString("utf8")) as {
    version?: unknown;
    experimentId?: unknown;
    workflow?: unknown;
    settlement?: { status?: unknown };
    chainId?: unknown;
    target?: unknown;
    reportBlock?: unknown;
    latestBlock?: unknown;
    observations?: unknown;
  };
  if (
    input.version !== 1 ||
    input.experimentId !== "full-due-diligence" ||
    input.status !== "ready-for-blind-execution" ||
    typeof input.task !== "string" ||
    input.taskHash !== sha256(input.task) ||
    input.bindings?.chainId !== 97 ||
    typeof input.bindings.proxy !== "string" ||
    typeof input.bindings.implementation !== "string" ||
    typeof input.bindings.sourceHash !== "string" ||
    !Number.isSafeInteger(input.bindings.reportBlock)
  ) {
    throw new Error("Experiment 3 baseline input is not locked to the expected task, chain, targets, source, and block");
  }
  if (
    securityInput.mode !== "verified-source" ||
    securityInput.chainId !== 97 ||
    !securityInput.sources ||
    securityInput.sourceHash !== input.bindings.sourceHash ||
    securityInput.sourceHash !== sha256(securityInput.source) ||
    securityInput.contractAddress?.toLowerCase() !== input.bindings.implementation.toLowerCase()
  ) {
    throw new Error("Experiment 3 verified source is not bound to the baseline input");
  }
  if (
    rpcEvidence.version !== 1 ||
    rpcEvidence.experimentId !== "token-risk" ||
    rpcEvidence.workflow !== "direct-read-only-rpc-baseline-candidate" ||
    rpcEvidence.settlement?.status !== "not-paid" ||
    rpcEvidence.chainId !== 97 ||
    typeof rpcEvidence.target !== "string" ||
    rpcEvidence.target.toLowerCase() !== input.bindings.proxy.toLowerCase() ||
    rpcEvidence.reportBlock !== input.bindings.reportBlock ||
    !Array.isArray(rpcEvidence.observations)
  ) {
    throw new Error("Experiment 3 direct RPC evidence is not independently bound to the proxy and report block");
  }

  const firstPartySourceUnits = Object.keys(securityInput.sources)
    .filter((sourceUnit) => sourceUnit.startsWith("src/"))
    .sort((left, right) => left.localeCompare(right));
  const dependencySourceUnits = Object.keys(securityInput.sources)
    .filter((sourceUnit) => !sourceUnit.startsWith("src/"))
    .sort((left, right) => left.localeCompare(right));
  if (firstPartySourceUnits.length === 0) {
    throw new Error("Experiment 3 verified package has no first-party src/ source units");
  }
  const firstPartySource = combinedFirstPartySource(securityInput.sources, firstPartySourceUnits);
  const slitherStartedAt = new Date();
  const slitherStarted = performance.now();
  const slither = runSlitherAnalysis(
    securityInput.source,
    securityInput.sourceName,
    securityInput.sources,
    securityInput.remappings
  );
  const slitherCompletedAt = new Date();
  const slitherEvidence = {
    version: 1,
    experimentId: "full-due-diligence",
    workflow: "ordinary-local-slither-baseline-candidate",
    status: slither.ok ? "measured" : "unavailable",
    settlement: { status: "not-paid", reason: "Local static analysis only." },
    inputBundleHash: sha256(inputRaw),
    sourceArtifact: "verified-source-input.json",
    sourceArtifactHash: sha256(sourceRaw),
    packageSourceHash: securityInput.sourceHash,
    command: "slither <verified package entry> --json - --disable-color --solc-disable-warnings --exclude-informational --exclude-optimization --solc-remaps <verified remappings>",
    tool: {
      name: "slither",
      version: slither.version ?? null,
      resultKind: "normalized-wrapper-output"
    },
    timing: {
      startedAt: slitherStartedAt.toISOString(),
      completedAt: slitherCompletedAt.toISOString(),
      wallDurationMs: Number((performance.now() - slitherStarted).toFixed(3))
    },
    ok: slither.ok,
    available: slither.available,
    detections: slither.detections,
    ...(slither.error ? { error: slither.error } : {}),
    limitations: [
      "The artifact retains the wrapper-normalized detector output, not Slither's process-level stdout/stderr bytes.",
      "Static detections are unreviewed signals and are not treated as confirmed vulnerabilities."
    ]
  };
  await writeJsonAtomic(slitherPath, slitherEvidence);

  const system = [
    "You are a general-purpose smart-contract due-diligence analyst working without multi-agent orchestration.",
    "Use only the supplied locked task, explorer-verified first-party source units, dependency manifest, fresh local Slither output, and direct read-only RPC evidence.",
    "Treat Slither detections as unreviewed signals, not confirmed vulnerabilities. Distinguish source-design risks from currently exploitable runtime conditions.",
    "Keep historical-unavailable evidence separate from latest-state evidence. Do not invent holder, liquidity, sellability, timelock, key-custody, or reputation facts.",
    "Return JSON only with findings, facts, trustDecision, reasons, requiredActions, coverage, and limitations."
  ].join("\n");
  const modelInput = {
    task: input.task,
    bindings: {
      chainId: 97,
      proxy: input.bindings.proxy,
      implementation: input.bindings.implementation,
      sourceHash: input.bindings.sourceHash,
      requiredComparisonBlock: input.bindings.reportBlock
    },
    verifiedFirstPartySource: {
      sourceUnits: firstPartySourceUnits,
      scopeSourceHash: sha256(firstPartySource),
      combinedSource: firstPartySource
    },
    dependencyManifest: {
      sourceUnits: dependencySourceUnits,
      reviewBoundary: "Dependency source contents are covered by compilation/static analysis, not supplied to the ordinary LLM."
    },
    localSlitherEvidence: slitherEvidence,
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
    experimentId: "full-due-diligence",
    workflow: "ordinary-llm-source-slither-rpc-candidate",
    status: "frozen-before-agent-report-comparison",
    inputBundleHash: sha256(inputRaw),
    taskHash: input.taskHash,
    sourceArtifactHash: sha256(sourceRaw),
    packageSourceHash: securityInput.sourceHash,
    scopedSourceHash: sha256(firstPartySource),
    slitherArtifactHash: sha256(await readFile(slitherPath)),
    rpcArtifactHash: sha256(rpcRaw),
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
    experimentId: "full-due-diligence",
    workflow: "without-agent-ordinary-llm-plus-slither-plus-direct-rpc-candidate",
    status: "non-blind-operator-candidate",
    input: {
      bundle: "baseline-input.json",
      bundleHash: sha256(inputRaw),
      taskHash: input.taskHash,
      chainId: 97,
      proxy: input.bindings.proxy,
      implementation: input.bindings.implementation,
      packageSourceHash: securityInput.sourceHash,
      scopedSourceHash: sha256(firstPartySource),
      reportBlock: input.bindings.reportBlock
    },
    rawEvidence: {
      sourceArtifact: "verified-source-input.json",
      sourceArtifactHash: sha256(sourceRaw),
      slitherArtifact: slitherArtifactName,
      slitherArtifactHash: modelEvidence.slitherArtifactHash,
      rpcArtifact: "../experiment-2-token-risk/baseline-rpc-raw.json",
      rpcArtifactHash: modelEvidence.rpcArtifactHash,
      modelArtifact: modelArtifactName,
      modelArtifactHash: sha256(await readFile(modelRawPath)),
      frozenBeforeAgentReportComparison: true
    },
    timing: {
      slitherDurationMs: slitherEvidence.timing.wallDurationMs,
      modelDurationMs: modelEvidence.timing.wallDurationMs,
      totalWallDurationMs: Number((slitherEvidence.timing.wallDurationMs + modelEvidence.timing.wallDurationMs).toFixed(3)),
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
      ...slitherEvidence.limitations,
      "The ordinary LLM received first-party src/ source units plus the dependency manifest and full-package Slither detections; dependency source text was omitted for context-size reliability.",
      "This is a model-plus-local-tool candidate, not the plan's independent human controlled baseline.",
      "No post-freeze independent quality or false-positive review has been recorded."
    ]
  });
  process.stdout.write(`${JSON.stringify({
    candidatePath: path.relative(repositoryRoot, candidatePath),
    model: response.model,
    slither: {
      available: slither.available,
      ok: slither.ok,
      version: slither.version,
      durationMs: slitherEvidence.timing.wallDurationMs,
      detections: slither.detections.length
    },
    modelDurationMs: modelEvidence.timing.wallDurationMs,
    usage: response.usage,
    controlledBaseline: false
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Due-diligence baseline candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
