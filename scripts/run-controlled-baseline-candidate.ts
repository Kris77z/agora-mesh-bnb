import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAuditGroundTruth,
  scoreAuditAgainstGroundTruth,
  type AuditGroundTruthManifest
} from "../agents/hunter/src/advantage-evaluator.js";
import { parseAuditReport } from "../agents/hunter/src/security-pipeline.js";
import { runOrdinaryBaselineModel } from "../agents/writer/src/ordinary-baseline-runner.js";
import type { AuditReport } from "@rebel/shared";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-1-contract-audit");
const inputPath = path.join(experimentDirectory, "baseline-input.json");
const sourcePath = path.join(experimentDirectory, "VulnerableVault.sol");
const groundTruthPath = path.join(experimentDirectory, "ground-truth.json");
const rawOutputPath = path.join(experimentDirectory, "baseline-model-raw.json");
const candidatePath = path.join(experimentDirectory, "baseline-output-candidate.json");

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
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim()
    : trimmed;
  return JSON.parse(candidate);
}

function normalizedConfidence(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "high") return 0.85;
  if (normalized === "medium") return 0.65;
  if (normalized === "low") return 0.4;
  return value;
}

function normalizeOrdinaryAuditReport(raw: string): AuditReport {
  const parsed = parseJsonCandidate(raw) as { vulnerabilities?: unknown };
  if (!Array.isArray(parsed.vulnerabilities)) {
    return parseAuditReport(JSON.stringify(parsed));
  }
  return parseAuditReport(JSON.stringify({
    vulnerabilities: parsed.vulnerabilities.map((finding) => {
      if (!finding || typeof finding !== "object") return finding;
      const record = finding as Record<string, unknown>;
      return { ...record, confidence: normalizedConfidence(record.confidence) };
    })
  }));
}

function categoryPattern(category: string): RegExp {
  if (category === "reentrancy") return /reentran/i;
  if (category === "tx-origin") return /tx\s*\.\s*origin|tx\s+origin/i;
  if (category === "delegatecall") return /delegate\s*call|delegatecall/i;
  return new RegExp(category.replaceAll(/[^a-zA-Z0-9]+/g, "\\s*"), "i");
}

function mapBlindFindingIdsAfterFreeze(
  report: AuditReport,
  groundTruth: AuditGroundTruthManifest
): {
  scoringReport: AuditReport;
  mappings: Array<{
    findingId: string;
    groundTruthId: string;
    category: string;
    reportedSeverity: string;
    expectedSeverity: string;
    severityMatches: boolean;
    method: string;
  }>;
} {
  const usedFindingIds = new Set<string>();
  const replacements = new Map<string, string>();
  const mappings: Array<{
    findingId: string;
    groundTruthId: string;
    category: string;
    reportedSeverity: string;
    expectedSeverity: string;
    severityMatches: boolean;
    method: string;
  }> = [];
  for (const truth of groundTruth.findings) {
    const pattern = categoryPattern(truth.category);
    const finding = report.vulnerabilities.find((candidate) => {
      if (usedFindingIds.has(candidate.findingId)) return false;
      const evidence = [
        candidate.title,
        candidate.description,
        candidate.evidence.snippet ?? ""
      ].join(" ");
      return pattern.test(evidence);
    });
    if (!finding) continue;
    usedFindingIds.add(finding.findingId);
    replacements.set(finding.findingId, truth.matchingFindingIds[0]!);
    mappings.push({
      findingId: finding.findingId,
      groundTruthId: truth.id,
      category: truth.category,
      reportedSeverity: finding.severity,
      expectedSeverity: truth.severity,
      severityMatches: finding.severity === truth.severity,
      method: "post-freeze deterministic category match; independent human review pending"
    });
  }
  return {
    mappings,
    scoringReport: {
      vulnerabilities: report.vulnerabilities.map((finding) => ({
        ...finding,
        findingId: replacements.get(finding.findingId) ?? finding.findingId
      }))
    }
  };
}

async function main(): Promise<void> {
  const baselineInput = JSON.parse(await readFile(inputPath, "utf8")) as {
    version?: unknown;
    experimentId?: unknown;
    status?: unknown;
    task?: unknown;
    taskHash?: unknown;
    bindings?: { sourceHash?: unknown };
  };
  const source = (await readFile(sourcePath, "utf8")).trim();
  if (
    baselineInput.version !== 1 ||
    baselineInput.experimentId !== "contract-audit" ||
    baselineInput.status !== "ready-for-blind-execution" ||
    typeof baselineInput.task !== "string" ||
    baselineInput.taskHash !== sha256(baselineInput.task) ||
    baselineInput.bindings?.sourceHash !== sha256(source)
  ) {
    throw new Error("Experiment 1 baseline input is not bound to the locked task and source");
  }

  const model = process.env.BASELINE_MODEL?.trim();
  const system = [
    "You are a general-purpose Solidity security analyst working without multi-agent orchestration.",
    "Use only the supplied task and source. Do not assume external facts or claim runtime exploitability.",
    "Return JSON only with the top-level shape {\"vulnerabilities\": SecurityFinding[]}.",
    "Every SecurityFinding must contain findingId, title, severity, description, evidence, exploitScenario, recommendation, and confidence.",
    "severity must be critical, high, medium, low, or info. evidence must include file, lines, and an exact source snippet.",
    "Report distinct root causes; do not duplicate one issue under multiple names."
  ].join("\n");
  const prompt = [
    `Task: ${baselineInput.task}`,
    "Source file: VulnerableVault.sol",
    "```solidity",
    source,
    "```"
  ].join("\n");
  let frozenRawEvidence: {
    version: number;
    experimentId: string;
    workflow: string;
    status: string;
    inputBundle: string;
    inputBundleHash: string;
    taskHash: string;
    sourceHash: string;
    model: { provider: string; model: string; sessionCount: number };
    timing: {
      startedAt: string;
      completedAt: string;
      wallDurationMs: number;
      operatorActiveMinutes: number;
      operatorType: string;
    };
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    prompts: { system: string; user: string };
    rawOutput: string;
    blindness: {
      llmContextExcludedAgentOutputs: boolean;
      llmContextExcludedGroundTruth: boolean;
      operatorWasIndependentHuman: boolean;
      operatorHadPriorProjectContext: boolean;
    };
  };
  if (process.env.BASELINE_REUSE_RAW === "true") {
    frozenRawEvidence = JSON.parse(await readFile(rawOutputPath, "utf8")) as typeof frozenRawEvidence;
    if (
      frozenRawEvidence.version !== 1 ||
      frozenRawEvidence.status !== "frozen-before-ground-truth-scoring" ||
      frozenRawEvidence.inputBundleHash !== sha256(await readFile(inputPath)) ||
      frozenRawEvidence.taskHash !== baselineInput.taskHash ||
      frozenRawEvidence.sourceHash !== baselineInput.bindings.sourceHash ||
      frozenRawEvidence.blindness.llmContextExcludedAgentOutputs !== true ||
      frozenRawEvidence.blindness.llmContextExcludedGroundTruth !== true
    ) {
      throw new Error("Frozen baseline model evidence is not bound to the current input bundle");
    }
  } else {
    const startedAt = new Date();
    const started = performance.now();
    const response = await runOrdinaryBaselineModel({ system, prompt, model });
    const completedAt = new Date();
    const durationMs = performance.now() - started;
    frozenRawEvidence = {
      version: 1,
      experimentId: "contract-audit",
      workflow: "ordinary-llm-direct-model-only",
      status: "frozen-before-ground-truth-scoring",
      inputBundle: "baseline-input.json",
      inputBundleHash: sha256(await readFile(inputPath)),
      taskHash: baselineInput.taskHash as string,
      sourceHash: baselineInput.bindings.sourceHash as string,
      model: {
        provider: response.provider,
        model: response.model,
        sessionCount: 1
      },
      timing: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        wallDurationMs: Number(durationMs.toFixed(3)),
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
    await writeJsonAtomic(rawOutputPath, frozenRawEvidence);
  }

  const auditReport = normalizeOrdinaryAuditReport(frozenRawEvidence.rawOutput);
  const groundTruth = await loadAuditGroundTruth(groundTruthPath);
  if (!groundTruth) throw new Error("Experiment 1 ground truth is missing after output freeze");
  const reviewMapping = mapBlindFindingIdsAfterFreeze(auditReport, groundTruth);
  const quality = scoreAuditAgainstGroundTruth({
    result: JSON.stringify(reviewMapping.scoringReport),
    sourceHash: baselineInput.bindings.sourceHash as string,
    groundTruth
  });
  if (!quality) throw new Error("Experiment 1 candidate could not be scored against reviewed ground truth");
  const rawArtifactHash = sha256(await readFile(rawOutputPath));
  await writeJsonAtomic(candidatePath, {
    version: 1,
    experimentId: "contract-audit",
    workflow: "without-agent-ordinary-llm-model-only-candidate",
    status: "non-blind-operator-candidate",
    input: {
      bundle: "baseline-input.json",
      bundleHash: frozenRawEvidence.inputBundleHash,
      taskHash: baselineInput.taskHash,
      sourceHash: baselineInput.bindings.sourceHash
    },
    rawEvidence: {
      artifact: "baseline-model-raw.json",
      artifactHash: rawArtifactHash,
      frozenBeforeGroundTruthScoring: true
    },
    timing: frozenRawEvidence.timing,
    model: frozenRawEvidence.model,
    usage: frozenRawEvidence.usage,
    cost: {
      modelUsd: null,
      toolUsd: 0,
      humanUsd: null,
      totalUsd: null,
      basis: "Provider token usage is captured, but invoice pricing and independent human labor were not available to this run."
    },
    report: auditReport,
    postFreezeReviewerMapping: reviewMapping.mappings,
    candidateQuality: quality,
    candidateSeverityAccuracy: {
      matched: reviewMapping.mappings.filter((mapping) => mapping.severityMatches).length,
      total: reviewMapping.mappings.length,
      accuracy: reviewMapping.mappings.length === 0
        ? 0
        : Number((reviewMapping.mappings.filter((mapping) => mapping.severityMatches).length /
            reviewMapping.mappings.length).toFixed(4))
    },
    comparisonEligibility: {
      controlledBaseline: false,
      reason: "The LLM context was isolated from Agent and ground-truth outputs, but the orchestrator was not an independent human and had prior project context."
    },
    limitations: [
      "This is a direct ordinary-model reference candidate, not the plan's independent human plus ordinary-LLM controlled baseline.",
      "Operator-active human minutes and labor cost are unavailable and must not be inferred as zero.",
      "Do not use this artifact to mark the controlled comparison complete."
    ]
  });
  process.stdout.write(`${JSON.stringify({
    candidatePath: path.relative(repositoryRoot, candidatePath),
    rawOutputPath: path.relative(repositoryRoot, rawOutputPath),
    model: frozenRawEvidence.model.model,
    durationMs: frozenRawEvidence.timing.wallDurationMs,
    usage: frozenRawEvidence.usage,
    findings: auditReport.vulnerabilities.length,
    candidateQuality: quality,
    controlledBaseline: false
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Controlled baseline candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
