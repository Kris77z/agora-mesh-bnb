import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenRiskReportHash } from "../agents/hunter/src/security-pipeline.js";
import type { OnchainRiskReport, SecurityTaskInput } from "@rebel/shared";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(repositoryRoot, "evidence");

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function material(relativePath: string): Promise<{ path: string; contentHash: string }> {
  const content = await readFile(path.join(repositoryRoot, relativePath));
  return { path: relativePath, contentHash: sha256(content) };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(temporaryPath, filePath);
}

function commonCaptureRequirements() {
  return {
    blindRun: {
      groundTruthHiddenUntilOutputFrozen: true,
      agentOutputsHiddenUntilOutputFrozen: true,
      contemporaneousTimingRequired: true
    },
    timing: ["startedAt", "completedAt", "wallDurationMs", "operatorActiveMinutes"],
    model: ["provider", "model", "sessionCount", "rawPromptArtifact", "rawOutputArtifact"],
    tools: ["name", "version", "commands", "rawOutputArtifacts"],
    cost: ["modelUsd", "toolUsd", "humanUsd", "totalUsd", "basis"],
    review: ["reviewer", "reviewedAt", "groundTruthOrRubric", "scoreArtifact"]
  };
}

async function buildExperiment1() {
  const directory = "evidence/experiment-1-contract-audit";
  const task = "Audit this benchmark Solidity contract for loss-of-funds vulnerabilities and validate every finding independently.";
  const source = (await readFile(path.join(repositoryRoot, directory, "VulnerableVault.sol"), "utf8")).trim();
  return {
    version: 1,
    experimentId: "contract-audit",
    workflow: "without-agent-human-plus-ordinary-llm",
    status: "ready-for-blind-execution",
    task,
    taskHash: sha256(task),
    bindings: {
      sourceHash: sha256(source),
      benchmarkId: "vulnerable-vault-v1"
    },
    materials: await Promise.all([
      material(`${directory}/VulnerableVault.sol`),
      material(`${directory}/input.md`),
      material(`${directory}/baseline-protocol.md`)
    ]),
    allowedWorkflow: ["one ordinary general-purpose LLM chat", "local Slither", "manual source review"],
    forbiddenInputsUntilOutputFrozen: [
      `${directory}/ground-truth.json`,
      `${directory}/agent-output.md`,
      `${directory}/metrics.json`,
      `${directory}/tool-baseline-output.json`
    ],
    captureRequirements: commonCaptureRequirements(),
    expectedOutput: {
      artifact: `${directory}/baseline-output.json`,
      findingsRequire: ["findingId", "title", "severity", "description", "evidence", "recommendation"],
      comparisonStatusBeforeReview: "pending"
    }
  };
}

async function readPaidTokenRisk(): Promise<{
  missionId: string;
  report: OnchainRiskReport;
}> {
  const paid = JSON.parse(await readFile(
    path.join(evidenceRoot, "experiment-2-token-risk/paid-run-output.json"),
    "utf8"
  )) as { mission?: { missionId?: string }; report?: OnchainRiskReport };
  if (!paid.mission?.missionId || paid.report?.version !== 1) {
    throw new Error("Experiment 2 paid evidence is unavailable");
  }
  return { missionId: paid.mission.missionId, report: paid.report };
}

async function buildExperiment2(paid: Awaited<ReturnType<typeof readPaidTokenRisk>>) {
  const directory = "evidence/experiment-2-token-risk";
  const task = "Investigate the onchain token and contract risk of 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565 on BNB Testnet.";
  return {
    version: 1,
    experimentId: "token-risk",
    workflow: "without-agent-human-plus-ordinary-llm",
    status: "ready-for-blind-execution",
    task,
    taskHash: sha256(task),
    bindings: {
      chainId: paid.report.chainId,
      target: paid.report.target.address,
      reportBlock: paid.report.blockNumber,
      agentReportHashForPostFreezeScoringOnly: tokenRiskReportHash(paid.report)
    },
    materials: await Promise.all([
      material(`${directory}/input.md`),
      material(`${directory}/baseline-protocol.md`)
    ]),
    allowedWorkflow: ["one ordinary general-purpose LLM chat", "BSC explorer", "direct read-only JSON-RPC"],
    forbiddenInputsUntilOutputFrozen: [
      `${directory}/paid-run-output.json`,
      `${directory}/security-review-output.json`,
      `${directory}/indexed-enrichment-output.json`,
      `${directory}/ground-truth-candidate.json`
    ],
    captureRequirements: commonCaptureRequirements(),
    expectedOutput: {
      artifact: `${directory}/baseline-output.json`,
      factsRequire: ["claim", "source", "observationBlock", "status"],
      reportRequire: ["riskSignals", "coverage", "limitations", "recommendation"],
      comparisonStatusBeforeReview: "pending"
    }
  };
}

async function buildExperiment3(paid: Awaited<ReturnType<typeof readPaidTokenRisk>>) {
  const directory = "evidence/experiment-3-due-diligence";
  const task = "Should the United Stables (U) contract used by Apex on BNB Testnet be trusted?";
  const sourceInput = JSON.parse(await readFile(
    path.join(repositoryRoot, directory, "verified-source-input.json"),
    "utf8"
  )) as SecurityTaskInput;
  if (sourceInput.mode !== "verified-source" || !sourceInput.contractAddress) {
    throw new Error("Experiment 3 verified source input is unavailable");
  }
  return {
    version: 1,
    experimentId: "full-due-diligence",
    workflow: "without-agent-human-plus-ordinary-llm",
    status: "ready-for-blind-execution",
    task,
    taskHash: sha256(task),
    bindings: {
      chainId: sourceInput.chainId,
      proxy: paid.report.target.address,
      implementation: sourceInput.contractAddress,
      sourceHash: sourceInput.sourceHash,
      reportBlock: paid.report.blockNumber,
      onchainReportHashForPostFreezeScoringOnly: tokenRiskReportHash(paid.report)
    },
    materials: await Promise.all([
      material(`${directory}/input.md`),
      material(`${directory}/baseline-protocol.md`),
      material(`${directory}/verified-source-input.json`)
    ]),
    allowedWorkflow: [
      "one ordinary general-purpose LLM chat",
      "BSC explorer",
      "local Slither",
      "direct read-only JSON-RPC",
      "manual DEX inspection"
    ],
    forbiddenInputsUntilOutputFrozen: [
      `${directory}/auditor-output.json`,
      `${directory}/verifier-output.json`,
      `${directory}/candidate-output.json`,
      `${directory}/runtime-triage-output.json`,
      `${directory}/model-finding-triage-candidate.md`,
      `${directory}/static-triage-candidate.md`,
      "evidence/experiment-2-token-risk/paid-run-output.json",
      "evidence/experiment-2-token-risk/security-review-output.json",
      "evidence/experiment-2-token-risk/indexed-enrichment-output.json"
    ],
    captureRequirements: commonCaptureRequirements(),
    expectedOutput: {
      artifact: `${directory}/baseline-output.json`,
      findingsRequire: ["findingId", "severity", "evidence", "assessment"],
      factsRequire: ["claim", "source", "observationBlock", "status"],
      reportRequire: ["trustDecision", "reasons", "requiredActions", "limitations"],
      comparisonStatusBeforeReview: "pending"
    }
  };
}

async function main(): Promise<void> {
  const paid = await readPaidTokenRisk();
  const bundles = await Promise.all([
    buildExperiment1(),
    buildExperiment2(paid),
    buildExperiment3(paid)
  ]);
  const paths = [
    path.join(evidenceRoot, "experiment-1-contract-audit/baseline-input.json"),
    path.join(evidenceRoot, "experiment-2-token-risk/baseline-input.json"),
    path.join(evidenceRoot, "experiment-3-due-diligence/baseline-input.json")
  ];
  await Promise.all(paths.map((outputPath, index) => writeJsonAtomic(outputPath, bundles[index])));
  process.stdout.write(`${JSON.stringify({
    status: "ready-for-blind-execution",
    bundles: paths.map((outputPath) => path.relative(repositoryRoot, outputPath)),
    modelCalled: false,
    networkAccessed: false
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Controlled baseline preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
