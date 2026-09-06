import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditReport, OnchainRiskReport, SecurityTaskInput } from "@rebel/shared";
import {
  loadAdvantageComparisonBundle,
  loadAuditGroundTruth,
  loadAuditToolBaseline,
  loadPaidDueDiligence,
  loadTokenRiskEnrichment,
  loadTokenRiskSecurityReview
} from "../agents/hunter/src/advantage-evaluator.js";
import {
  loadDueDiligenceCandidate,
  type DueDiligenceCandidateEvidence
} from "../agents/hunter/src/due-diligence.js";
import {
  parseAuditReport,
  parseOnchainRiskReport,
  parseTokenRiskVerificationReport,
  parseVerificationReport,
  tokenRiskReportHash
} from "../agents/hunter/src/security-pipeline.js";
import { verifyReceiptTool } from "../agents/hunter/src/tools/verify.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(repositoryRoot, "evidence");

interface DynamicServiceEntry {
  agentId?: string;
  service?: {
    id?: string;
    provider?: string;
    taskType?: string;
  };
}

interface BaselineInputBundle {
  version: number;
  experimentId: string;
  workflow: string;
  status: string;
  task: string;
  taskHash: string;
  bindings: Record<string, unknown>;
  materials: Array<{ path: string; contentHash: string }>;
  allowedWorkflow: string[];
  forbiddenInputsUntilOutputFrozen: string[];
  captureRequirements: {
    blindRun?: {
      groundTruthHiddenUntilOutputFrozen?: boolean;
      agentOutputsHiddenUntilOutputFrozen?: boolean;
      contemporaneousTimingRequired?: boolean;
    };
  };
  expectedOutput: { artifact?: string; comparisonStatusBeforeReview?: string };
}

interface TokenRiskBaselineRpcEvidence {
  version: number;
  experimentId: string;
  workflow: string;
  settlement: { status: string };
  inputBundleHash: string;
  taskHash: string;
  chainId: number;
  target: string;
  reportBlock: number;
  latestBlock: number;
  timing: { durationMs: number };
  observations: Array<{
    label: string;
    blockNumber: number;
    status: "measured" | "unavailable";
    value?: unknown;
    reason?: string;
  }>;
}

interface TokenRiskBaselineModelEvidence {
  version: number;
  experimentId: string;
  status: string;
  inputBundleHash: string;
  rpcArtifactHash: string;
  model: { provider: string; model: string; sessionCount: number };
  timing: { wallDurationMs: number; operatorActiveMinutes: number; operatorType: string };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  prompts: { system: string; user: string };
  rawOutput: string;
  blindness: {
    llmContextExcludedAgentOutputs: boolean;
    llmContextExcludedGroundTruth: boolean;
    operatorWasIndependentHuman: boolean;
    operatorHadPriorProjectContext: boolean;
  };
}

interface TokenRiskBaselineCandidate {
  version: number;
  experimentId: string;
  status: string;
  input: {
    bundleHash: string;
    taskHash: string;
    chainId: number;
    target: string;
    reportBlock: number;
  };
  rawEvidence: {
    rpcArtifactHash: string;
    modelArtifactHash: string;
    frozenBeforeAgentReportComparison: boolean;
  };
  timing: {
    rpcDurationMs: number;
    modelDurationMs: number;
    totalWallDurationMs: number;
    operatorActiveMinutes: number;
    operatorType: string;
  };
  model: { provider: string; model: string; sessionCount: number };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  report: {
    facts: Array<{
      claim: string;
      status: "measured" | "unavailable";
      source: string;
      observationBlock: number;
    }>;
    riskSignals: Array<{ severity: string; category: string; claim: string; evidence: unknown }>;
    coverage: { covered: string[]; notCovered: string[] };
    recommendation: string;
    limitations: string[];
  };
  comparisonEligibility: { controlledBaseline: boolean };
  limitations: string[];
}

interface HolderSnapshotEvidence {
  version: number;
  experimentId: string;
  evidenceKind: string;
  status: string;
  source: {
    missionId: string;
    evidenceFileHash: string;
    reportHash: string;
    holderIndex: {
      provider: string;
      indexedHolderCount: number;
      pageSize: number;
      pagesRead: number;
      inputHash: string;
    };
  };
  target: {
    chainId: number;
    address: string;
    snapshotBlock: number;
    snapshotBlockHash: string;
  };
  engine: { method: string };
  snapshot: {
    totalSupplyRaw: string;
    indexedAddressCount: number;
    holderCount: number;
    holders: Array<{ rank: number; address: string; balanceRaw: string }>;
    concentration: {
      top1PartsPerMillion: number;
      top5PartsPerMillion: number;
      top10PartsPerMillion: number;
    };
  };
  validation: {
    complete: boolean;
    candidateAddressCount: number;
    positiveBalanceCount: number;
    blockBalanceSumRaw: string;
    totalSupplyRaw: string;
    balanceReadFailures: number;
    missingSupplyRaw: string;
  };
}

interface SellabilityEvidence {
  version: number;
  evidenceKind: string;
  status: string;
  chainId: number;
  wallet: string;
  input: { address: string; amountRaw: string };
  output: { amountRaw: string };
  protection: { slippageBps: number; minimumOutRaw: string };
  balances: { routerAllowanceAfterSwapRaw: string };
  transactions: {
    exactApproval: { hash: string; blockNumber: number };
    swap: { hash: string; blockNumber: number };
  };
}

interface DueDiligenceBaselineSlitherEvidence {
  version: number;
  experimentId: string;
  workflow: string;
  status: string;
  settlement: { status: string };
  inputBundleHash: string;
  sourceArtifactHash: string;
  packageSourceHash: string;
  tool: { name: string; version: string | null; resultKind: string };
  timing: { wallDurationMs: number };
  ok: boolean;
  available: boolean;
  detections: Array<{ id: string; file?: string; line: number; note: string }>;
  error?: string;
}

interface DueDiligenceBaselineModelEvidence {
  version: number;
  experimentId: string;
  status: string;
  inputBundleHash: string;
  taskHash: string;
  sourceArtifactHash: string;
  packageSourceHash: string;
  scopedSourceHash: string;
  slitherArtifactHash: string;
  rpcArtifactHash: string;
  model: { provider: string; model: string; sessionCount: number };
  timing: { wallDurationMs: number; operatorActiveMinutes: number; operatorType: string };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  prompts: { system: string; user: string };
  rawOutput: string;
  blindness: {
    llmContextExcludedAgentOutputs: boolean;
    llmContextExcludedGroundTruth: boolean;
    operatorWasIndependentHuman: boolean;
    operatorHadPriorProjectContext: boolean;
  };
}

interface DueDiligenceBaselineCandidate {
  version: number;
  experimentId: string;
  status: string;
  input: {
    bundleHash: string;
    taskHash: string;
    chainId: number;
    proxy: string;
    implementation: string;
    packageSourceHash: string;
    scopedSourceHash: string;
    reportBlock: number;
  };
  rawEvidence: {
    sourceArtifactHash: string;
    slitherArtifactHash: string;
    rpcArtifactHash: string;
    modelArtifactHash: string;
    frozenBeforeAgentReportComparison: boolean;
  };
  timing: {
    slitherDurationMs: number;
    modelDurationMs: number;
    operatorActiveMinutes: number;
    operatorType: string;
  };
  model: { provider: string; model: string; sessionCount: number };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  report: {
    findings: unknown[];
    facts: Record<string, unknown>;
    trustDecision: string;
    reasons: string[];
    requiredActions: string[];
    coverage: string[];
    limitations: string[];
  };
  postFreezeOperatorReview: {
    status: string;
    reviewer: string;
    independentHuman: boolean;
    trustDecisionChanged: boolean;
    corrections: Array<{ location: string; issue: string; correction: string }>;
  };
  comparisonEligibility: { controlledBaseline: boolean };
  limitations: string[];
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseJsonModelOutput(raw: string): unknown {
  const trimmed = raw.trim();
  const json = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim()
    : trimmed;
  return JSON.parse(json) as unknown;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function validateBaselineBundle(
  relativeDirectory: string,
  expectedExperimentId: string
): Promise<BaselineInputBundle> {
  const bundle = await readJson<BaselineInputBundle>(
    path.join(repositoryRoot, relativeDirectory, "baseline-input.json")
  );
  invariant(bundle.version === 1, `${expectedExperimentId} baseline input version mismatch`);
  invariant(bundle.experimentId === expectedExperimentId, `${expectedExperimentId} baseline experiment mismatch`);
  invariant(bundle.workflow === "without-agent-human-plus-ordinary-llm", `${expectedExperimentId} baseline workflow mismatch`);
  invariant(bundle.status === "ready-for-blind-execution", `${expectedExperimentId} baseline input is not ready`);
  invariant(bundle.task.trim().length > 0 && sha256(bundle.task) === bundle.taskHash, `${expectedExperimentId} baseline task hash mismatch`);
  invariant(Array.isArray(bundle.materials) && bundle.materials.length > 0, `${expectedExperimentId} baseline materials are missing`);
  invariant(Array.isArray(bundle.allowedWorkflow) && bundle.allowedWorkflow.length > 0, `${expectedExperimentId} baseline allowed workflow is missing`);
  invariant(Array.isArray(bundle.forbiddenInputsUntilOutputFrozen) && bundle.forbiddenInputsUntilOutputFrozen.length > 0, `${expectedExperimentId} baseline blind exclusions are missing`);
  invariant(bundle.captureRequirements.blindRun?.groundTruthHiddenUntilOutputFrozen === true, `${expectedExperimentId} baseline does not hide ground truth`);
  invariant(bundle.captureRequirements.blindRun?.agentOutputsHiddenUntilOutputFrozen === true, `${expectedExperimentId} baseline does not hide Agent output`);
  invariant(bundle.captureRequirements.blindRun?.contemporaneousTimingRequired === true, `${expectedExperimentId} baseline timing is not contemporaneous`);
  invariant(bundle.expectedOutput.comparisonStatusBeforeReview === "pending", `${expectedExperimentId} baseline comparison must remain pending`);
  const forbidden = new Set(bundle.forbiddenInputsUntilOutputFrozen);
  for (const item of bundle.materials) {
    invariant(!forbidden.has(item.path), `${expectedExperimentId} baseline exposes forbidden material ${item.path}`);
    const materialPath = path.resolve(repositoryRoot, item.path);
    const relative = path.relative(repositoryRoot, materialPath);
    invariant(!relative.startsWith("..") && !path.isAbsolute(relative), `${expectedExperimentId} baseline material escapes the repository`);
    invariant(sha256(await readFile(materialPath)) === item.contentHash, `${expectedExperimentId} baseline material hash mismatch for ${item.path}`);
  }
  const expectedArtifact = bundle.expectedOutput.artifact;
  invariant(
    typeof expectedArtifact === "string" && expectedArtifact.startsWith(`${relativeDirectory}/`),
    `${expectedExperimentId} baseline output artifact is outside its evidence directory`
  );
  return bundle;
}

function serviceById(entries: DynamicServiceEntry[], serviceId: string): DynamicServiceEntry {
  const entry = entries.find((candidate) => candidate.service?.id === serviceId);
  invariant(entry?.agentId, `Registry is missing ${serviceId} agent identity`);
  invariant(entry.service?.provider, `Registry is missing ${serviceId} provider wallet`);
  return entry;
}

async function validateNoSecretFields(directory: string): Promise<number> {
  const forbidden = new Set([
    "privatekey",
    "sessionprivatekey",
    "adminprivatekey",
    "apikey",
    "encryptionkey",
    "mnemonic",
    "seedphrase"
  ]);
  let validatedFiles = 0;
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = await readJson<unknown>(entryPath);
      const inspect = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(inspect);
          return;
        }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          invariant(
            !forbidden.has(key.replaceAll(/[^a-zA-Z]/g, "").toLowerCase()),
            `Public evidence contains forbidden secret-like field ${key} in ${path.relative(repositoryRoot, entryPath)}`
          );
          inspect(child);
        }
      };
      inspect(parsed);
      validatedFiles += 1;
    }
  }
  await visit(directory);
  return validatedFiles;
}

async function validateExperiment1(): Promise<Record<string, unknown>> {
  const directory = path.join(evidenceRoot, "experiment-1-contract-audit");
  const source = (await readFile(path.join(directory, "VulnerableVault.sol"), "utf8")).trim();
  const sourceHash = sha256(source);
  const [groundTruth, toolBaseline, metrics, baseline, baselineRaw, baselineCandidate] = await Promise.all([
    loadAuditGroundTruth(path.join(directory, "ground-truth.json")),
    loadAuditToolBaseline(path.join(directory, "tool-baseline-output.json")),
    readJson<{
      version: number;
      experimentId: string;
      benchmarkId: string;
      agent: {
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
        precision: number;
        recall: number;
      };
      baseline: { status: string };
      toolReference: {
        detections: number;
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
        precision: number;
        recall: number;
      };
      comparison: { status: string };
    }>(path.join(directory, "metrics.json")),
    validateBaselineBundle("evidence/experiment-1-contract-audit", "contract-audit"),
    readJson<{
      version: number;
      status: string;
      inputBundleHash: string;
      taskHash: string;
      sourceHash: string;
      model: { provider: string; model: string };
      timing: { wallDurationMs: number; operatorType: string };
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      blindness: {
        llmContextExcludedAgentOutputs: boolean;
        llmContextExcludedGroundTruth: boolean;
        operatorWasIndependentHuman: boolean;
      };
    }>(path.join(directory, "baseline-model-raw.json")),
    readJson<{
      version: number;
      status: string;
      input: { bundleHash: string; taskHash: string; sourceHash: string };
      rawEvidence: { artifactHash: string; frozenBeforeGroundTruthScoring: boolean };
      report: AuditReport;
      postFreezeReviewerMapping: Array<{ severityMatches: boolean }>;
      candidateQuality: {
        groundTruthFindings: number;
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
      };
      candidateSeverityAccuracy: { matched: number; total: number; accuracy: number };
      comparisonEligibility: { controlledBaseline: boolean };
    }>(path.join(directory, "baseline-output-candidate.json"))
  ]);
  invariant(groundTruth, "Experiment 1 ground truth is missing");
  invariant(toolBaseline, "Experiment 1 tool baseline is missing");
  invariant(groundTruth.reviewStatus === "reviewed", "Experiment 1 ground truth is not reviewed");
  invariant(groundTruth.sourceHash === sourceHash, "Experiment 1 ground-truth source hash mismatch");
  invariant(toolBaseline.input.sourceHash === sourceHash, "Experiment 1 tool source hash mismatch");
  invariant(toolBaseline.input.benchmarkId === groundTruth.benchmarkId, "Experiment 1 benchmark ID mismatch");
  invariant(toolBaseline.quality.groundTruthSourceHash === sourceHash, "Experiment 1 quality hash mismatch");
  invariant(metrics.version === 1 && metrics.experimentId === "contract-audit", "Experiment 1 metrics format mismatch");
  invariant(metrics.benchmarkId === groundTruth.benchmarkId, "Experiment 1 metrics benchmark mismatch");
  invariant(metrics.toolReference.detections === toolBaseline.output.detections.length, "Experiment 1 detection count mismatch");
  for (const field of ["truePositives", "falsePositives", "falseNegatives", "precision", "recall"] as const) {
    invariant(metrics.toolReference[field] === toolBaseline.quality[field], `Experiment 1 tool metric ${field} mismatch`);
  }
  invariant(metrics.agent.truePositives + metrics.agent.falseNegatives === groundTruth.findings.length, "Experiment 1 agent quality totals mismatch ground truth");
  invariant(metrics.baseline.status === "pending", "Experiment 1 controlled baseline must remain pending until recorded");
  invariant(metrics.comparison.status === "pending", "Experiment 1 comparison must remain pending until baseline completion");
  invariant(baseline.bindings.sourceHash === sourceHash, "Experiment 1 baseline source binding mismatch");
  invariant(baseline.bindings.benchmarkId === groundTruth.benchmarkId, "Experiment 1 baseline benchmark mismatch");
  const baselineInputHash = sha256(await readFile(path.join(directory, "baseline-input.json")));
  invariant(baselineRaw.version === 1 && baselineRaw.status === "frozen-before-ground-truth-scoring", "Experiment 1 raw model baseline is not frozen");
  invariant(baselineRaw.inputBundleHash === baselineInputHash, "Experiment 1 raw model baseline input hash mismatch");
  invariant(baselineRaw.taskHash === baseline.taskHash && baselineRaw.sourceHash === sourceHash, "Experiment 1 raw model baseline task/source mismatch");
  invariant(baselineRaw.blindness.llmContextExcludedAgentOutputs === true && baselineRaw.blindness.llmContextExcludedGroundTruth === true, "Experiment 1 model context was not blind");
  invariant(baselineRaw.blindness.operatorWasIndependentHuman === false, "Experiment 1 candidate incorrectly claims an independent human operator");
  invariant(baselineCandidate.version === 1 && baselineCandidate.status === "non-blind-operator-candidate", "Experiment 1 model baseline candidate status mismatch");
  invariant(baselineCandidate.input.bundleHash === baselineInputHash && baselineCandidate.input.taskHash === baseline.taskHash && baselineCandidate.input.sourceHash === sourceHash, "Experiment 1 model baseline candidate input mismatch");
  invariant(baselineCandidate.rawEvidence.artifactHash === sha256(await readFile(path.join(directory, "baseline-model-raw.json"))), "Experiment 1 raw/candidate artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.frozenBeforeGroundTruthScoring === true, "Experiment 1 candidate was not frozen before scoring");
  parseAuditReport(JSON.stringify(baselineCandidate.report));
  invariant(baselineCandidate.candidateQuality.groundTruthFindings === groundTruth.findings.length, "Experiment 1 candidate ground-truth total mismatch");
  invariant(baselineCandidate.candidateQuality.truePositives + baselineCandidate.candidateQuality.falseNegatives === groundTruth.findings.length, "Experiment 1 candidate quality totals mismatch");
  const severityMatches = baselineCandidate.postFreezeReviewerMapping.filter((mapping) => mapping.severityMatches).length;
  invariant(baselineCandidate.candidateSeverityAccuracy.matched === severityMatches && baselineCandidate.candidateSeverityAccuracy.total === baselineCandidate.postFreezeReviewerMapping.length, "Experiment 1 candidate severity totals mismatch");
  invariant(baselineCandidate.comparisonEligibility.controlledBaseline === false, "Experiment 1 candidate must not complete the controlled baseline");
  return {
    sourceHash,
    groundTruthFindings: groundTruth.findings.length,
    toolDetections: toolBaseline.output.detections.length,
    controlledBaseline: metrics.baseline.status,
    modelOnlyCandidate: {
      model: `${baselineRaw.model.provider}/${baselineRaw.model.model}`,
      durationMs: baselineRaw.timing.wallDurationMs,
      totalTokens: baselineRaw.usage.totalTokens,
      findings: baselineCandidate.report.vulnerabilities.length,
      candidateTruePositives: baselineCandidate.candidateQuality.truePositives,
      severityAccuracy: baselineCandidate.candidateSeverityAccuracy.accuracy,
      controlled: false
    }
  };
}

async function validateExperiment2(
  services: DynamicServiceEntry[]
): Promise<{
  paidRun: OnchainRiskReport;
  missionId: string;
  transactionHash: string;
  reportHash: string;
  modelOnlyCandidate: {
    model: string;
    rpcDurationMs: number;
    modelDurationMs: number;
    totalTokens: number;
    historicalMeasured: number;
    historicalUnavailable: number;
    riskSignals: number;
    controlled: false;
  };
}> {
  const directory = path.join(evidenceRoot, "experiment-2-token-risk");
  const paidRaw = await readFile(path.join(directory, "paid-run-output.json"), "utf8");
  const paid = JSON.parse(paidRaw) as {
    version: number;
    experimentId: string;
    workflowStatus: string;
    mission: { missionId: string };
    payment: {
      transaction: string;
      amount: { amount: string; asset: { chainId: number; address?: string; symbol: string } };
    };
    report: OnchainRiskReport;
  };
  invariant(paid.version === 1 && paid.experimentId === "token-risk", "Experiment 2 paid evidence format mismatch");
  invariant(/^0x[0-9a-fA-F]{64}$/.test(paid.payment.transaction), "Experiment 2 payment transaction is invalid");
  invariant(/^\d+$/.test(paid.payment.amount.amount) && BigInt(paid.payment.amount.amount) > 0n, "Experiment 2 payment amount is invalid");
  const report = parseOnchainRiskReport(JSON.stringify(paid.report));
  invariant(report.chainId === 97, "Experiment 2 is not bound to BNB Testnet");
  invariant(paid.payment.amount.asset.chainId === report.chainId, "Experiment 2 payment/report chain mismatch");
  invariant(paid.payment.amount.asset.address && sameAddress(paid.payment.amount.asset.address, report.target.address), "Experiment 2 payment asset/target mismatch");
  const reportHash = tokenRiskReportHash(report);
  const [review, enrichment, holderSnapshot, sellability] = await Promise.all([
    loadTokenRiskSecurityReview(path.join(directory, "security-review-output.json")),
    loadTokenRiskEnrichment(path.join(directory, "indexed-enrichment-output.json")),
    readJson<HolderSnapshotEvidence>(path.join(directory, "holder-snapshot-output.json")),
    readJson<SellabilityEvidence>(path.join(directory, "sellability-execution-output.json"))
  ]);
  const baseline = await validateBaselineBundle(
    "evidence/experiment-2-token-risk",
    "token-risk"
  );
  invariant(review, "Experiment 2 independent review is missing");
  invariant(enrichment, "Experiment 2 enrichment is missing");
  invariant(review.source.missionId === paid.mission.missionId, "Experiment 2 review mission mismatch");
  invariant(review.source.reportHash === reportHash, "Experiment 2 review report hash mismatch");
  invariant(review.reviewer.serviceId === "risk-verifier-v1", "Experiment 2 reviewer service mismatch");
  parseTokenRiskVerificationReport(JSON.stringify(review.review), report);
  invariant(enrichment.source.missionId === paid.mission.missionId, "Experiment 2 enrichment mission mismatch");
  invariant(enrichment.source.reportHash === reportHash, "Experiment 2 enrichment report hash mismatch");
  invariant(enrichment.source.blockNumber === report.blockNumber, "Experiment 2 enrichment block mismatch");
  invariant(sameAddress(enrichment.source.target, report.target.address), "Experiment 2 enrichment target mismatch");
  invariant(enrichment.coverage.originalMeasured === 5 && enrichment.coverage.postRunMeasured === 8 && enrichment.coverage.total === 8, "Experiment 2 enrichment is not complete 8/8 coverage");
  invariant(enrichment.coverage.partial.length === 0 && enrichment.coverage.unavailable.length === 0, "Experiment 2 enrichment retains partial or unavailable dimensions");
  invariant(
    holderSnapshot.version === 1 && holderSnapshot.experimentId === "token-risk" &&
      holderSnapshot.evidenceKind === "complete-holder-snapshot" && holderSnapshot.status === "measured",
    "Experiment 2 holder snapshot format mismatch"
  );
  invariant(holderSnapshot.source.missionId === paid.mission.missionId && holderSnapshot.source.reportHash === reportHash, "Experiment 2 holder snapshot source binding mismatch");
  invariant(holderSnapshot.source.evidenceFileHash === sha256(paidRaw), "Experiment 2 holder snapshot paid evidence hash mismatch");
  invariant(holderSnapshot.source.holderIndex.provider === "BscScan Testnet", "Experiment 2 holder index provider mismatch");
  invariant(holderSnapshot.source.holderIndex.pageSize === 100 && holderSnapshot.source.holderIndex.pagesRead === 5, "Experiment 2 holder pagination evidence mismatch");
  invariant(/^sha256:[0-9a-f]{64}$/.test(holderSnapshot.source.holderIndex.inputHash), "Experiment 2 holder index input hash is invalid");
  invariant(holderSnapshot.target.chainId === report.chainId && sameAddress(holderSnapshot.target.address, report.target.address), "Experiment 2 holder target mismatch");
  invariant(holderSnapshot.target.snapshotBlock >= report.blockNumber && /^0x[0-9a-fA-F]{64}$/.test(holderSnapshot.target.snapshotBlockHash), "Experiment 2 holder snapshot block is invalid");
  invariant(holderSnapshot.engine.method === "complete-indexed-holder-set-plus-block-locked-balance-reconciliation", "Experiment 2 holder snapshot method mismatch");
  invariant(holderSnapshot.snapshot.indexedAddressCount === 422 && holderSnapshot.snapshot.holderCount === 422, "Experiment 2 holder count is incomplete");
  invariant(holderSnapshot.source.holderIndex.indexedHolderCount === holderSnapshot.snapshot.holderCount, "Experiment 2 indexed holder count mismatch");
  invariant(holderSnapshot.snapshot.holders.length === holderSnapshot.snapshot.holderCount, "Experiment 2 holder rows are incomplete");
  invariant(new Set(holderSnapshot.snapshot.holders.map((holder) => holder.address.toLowerCase())).size === holderSnapshot.snapshot.holderCount, "Experiment 2 holder rows contain duplicate addresses");
  holderSnapshot.snapshot.holders.forEach((holder, index) => {
    invariant(holder.rank === index + 1, `Experiment 2 holder rank mismatch at ${index + 1}`);
    invariant(/^0x[0-9a-fA-F]{40}$/.test(holder.address) && /^\d+$/.test(holder.balanceRaw) && BigInt(holder.balanceRaw) > 0n, `Experiment 2 holder row ${index + 1} is invalid`);
  });
  const holderBalanceSum = holderSnapshot.snapshot.holders.reduce((sum, holder) => sum + BigInt(holder.balanceRaw), 0n);
  invariant(holderBalanceSum.toString() === holderSnapshot.snapshot.totalSupplyRaw, "Experiment 2 holder balances do not sum to totalSupply");
  invariant(holderSnapshot.snapshot.totalSupplyRaw === report.facts.token?.totalSupply, "Experiment 2 holder totalSupply/report mismatch");
  invariant(
    holderSnapshot.validation.complete === true &&
      holderSnapshot.validation.candidateAddressCount === 422 &&
      holderSnapshot.validation.positiveBalanceCount === 422 &&
      holderSnapshot.validation.blockBalanceSumRaw === holderSnapshot.snapshot.totalSupplyRaw &&
      holderSnapshot.validation.totalSupplyRaw === holderSnapshot.snapshot.totalSupplyRaw &&
      holderSnapshot.validation.balanceReadFailures === 0 &&
      holderSnapshot.validation.missingSupplyRaw === "0",
    "Experiment 2 holder reconciliation is incomplete"
  );
  invariant(
    sellability.version === 1 && sellability.evidenceKind === "executed-sellability-test" &&
      sellability.status === "confirmed" && sellability.chainId === report.chainId &&
      sameAddress(sellability.input.address, report.target.address),
    "Experiment 2 sellability evidence binding mismatch"
  );
  invariant(BigInt(sellability.input.amountRaw) === 100_000_000_000_000_000n, "Experiment 2 sellability input is not exactly 0.1 U");
  invariant(BigInt(sellability.output.amountRaw) >= BigInt(sellability.protection.minimumOutRaw) && sellability.protection.slippageBps === 500, "Experiment 2 sellability slippage protection failed");
  invariant(sellability.balances.routerAllowanceAfterSwapRaw === "0", "Experiment 2 sellability left Router allowance");
  invariant(/^0x[0-9a-fA-F]{64}$/.test(sellability.transactions.exactApproval.hash) && /^0x[0-9a-fA-F]{64}$/.test(sellability.transactions.swap.hash), "Experiment 2 sellability transaction hash is invalid");
  invariant(enrichment.indexedData.holderConcentration.status === "measured" && enrichment.indexedData.holderConcentration.holderCount === 422, "Experiment 2 enrichment did not bind the holder snapshot");
  invariant(enrichment.dex.coverage.sellability === "measured" && enrichment.sellabilityExecution?.swapTransaction === sellability.transactions.swap.hash, "Experiment 2 enrichment did not bind executed sellability");
  invariant(baseline.bindings.chainId === report.chainId, "Experiment 2 baseline chain mismatch");
  invariant(typeof baseline.bindings.target === "string" && sameAddress(baseline.bindings.target, report.target.address), "Experiment 2 baseline target mismatch");
  invariant(baseline.bindings.reportBlock === report.blockNumber, "Experiment 2 baseline block mismatch");
  invariant(baseline.bindings.agentReportHashForPostFreezeScoringOnly === reportHash, "Experiment 2 baseline scoring hash mismatch");
  const baselineInputHash = sha256(await readFile(path.join(directory, "baseline-input.json")));
  const [baselineRpc, baselineModel, baselineCandidate] = await Promise.all([
    readJson<TokenRiskBaselineRpcEvidence>(path.join(directory, "baseline-rpc-raw.json")),
    readJson<TokenRiskBaselineModelEvidence>(path.join(directory, "baseline-model-raw.json")),
    readJson<TokenRiskBaselineCandidate>(path.join(directory, "baseline-output-candidate.json"))
  ]);
  invariant(
    baselineRpc.version === 1 &&
      baselineRpc.experimentId === "token-risk" &&
      baselineRpc.workflow === "direct-read-only-rpc-baseline-candidate" &&
      baselineRpc.settlement.status === "not-paid",
    "Experiment 2 direct RPC candidate format/settlement mismatch"
  );
  invariant(baselineRpc.inputBundleHash === baselineInputHash, "Experiment 2 direct RPC input hash mismatch");
  invariant(baselineRpc.taskHash === baseline.taskHash, "Experiment 2 direct RPC task hash mismatch");
  invariant(baselineRpc.chainId === report.chainId, "Experiment 2 direct RPC chain mismatch");
  invariant(sameAddress(baselineRpc.target, report.target.address), "Experiment 2 direct RPC target mismatch");
  invariant(baselineRpc.reportBlock === report.blockNumber, "Experiment 2 direct RPC report block mismatch");
  invariant(Number.isSafeInteger(baselineRpc.latestBlock) && baselineRpc.latestBlock >= baselineRpc.reportBlock, "Experiment 2 direct RPC latest block is invalid");
  invariant(Number.isFinite(baselineRpc.timing.durationMs) && baselineRpc.timing.durationMs > 0, "Experiment 2 direct RPC timing is invalid");
  const expectedObservationLabels = new Set([
    "nativeBalanceWei",
    "transactionCount",
    "bytecode",
    "name",
    "symbol",
    "decimals",
    "totalSupply",
    "owner",
    "getOwner",
    "eip1967Implementation",
    "eip1967Admin"
  ]);
  for (const blockNumber of [baselineRpc.reportBlock, baselineRpc.latestBlock]) {
    const blockObservations = baselineRpc.observations.filter((observation) => observation.blockNumber === blockNumber);
    invariant(blockObservations.length === expectedObservationLabels.size, `Experiment 2 direct RPC observation count mismatch at block ${blockNumber}`);
    invariant(new Set(blockObservations.map((observation) => observation.label)).size === expectedObservationLabels.size, `Experiment 2 direct RPC observations are duplicated at block ${blockNumber}`);
    for (const observation of blockObservations) {
      invariant(expectedObservationLabels.has(observation.label), `Experiment 2 direct RPC has unexpected observation ${observation.label}`);
      invariant(observation.status === "measured" || observation.status === "unavailable", `Experiment 2 direct RPC status is invalid for ${observation.label}`);
      invariant(
        observation.status === "measured" ? observation.value !== undefined : typeof observation.reason === "string" && observation.reason.length > 0,
        `Experiment 2 direct RPC evidence is incomplete for ${observation.label}`
      );
    }
  }
  const historicalMeasured = baselineRpc.observations.filter((observation) => observation.blockNumber === baselineRpc.reportBlock && observation.status === "measured").length;
  const historicalUnavailable = baselineRpc.observations.filter((observation) => observation.blockNumber === baselineRpc.reportBlock && observation.status === "unavailable").length;
  invariant(historicalMeasured > 0 && historicalUnavailable > 0, "Experiment 2 direct RPC must retain both measured and unavailable historical evidence");
  const rpcArtifactHash = sha256(await readFile(path.join(directory, "baseline-rpc-raw.json")));
  invariant(
    baselineModel.version === 1 && baselineModel.experimentId === "token-risk" && baselineModel.status === "frozen-before-agent-report-comparison",
    "Experiment 2 raw model candidate is not frozen"
  );
  invariant(baselineModel.inputBundleHash === baselineInputHash && baselineModel.rpcArtifactHash === rpcArtifactHash, "Experiment 2 raw model input/RPC hash mismatch");
  invariant(baselineModel.blindness.llmContextExcludedAgentOutputs === true && baselineModel.blindness.llmContextExcludedGroundTruth === true, "Experiment 2 model context was not blind");
  invariant(baselineModel.blindness.operatorWasIndependentHuman === false && baselineModel.blindness.operatorHadPriorProjectContext === true, "Experiment 2 candidate operator disclosure mismatch");
  invariant(baselineModel.timing.operatorActiveMinutes === 0 && baselineModel.timing.operatorType === "automated-codex-orchestrator", "Experiment 2 automated timing disclosure mismatch");
  invariant(baselineModel.usage.promptTokens + baselineModel.usage.completionTokens === baselineModel.usage.totalTokens, "Experiment 2 model token usage mismatch");
  const modelPrompt = JSON.parse(baselineModel.prompts.user) as Record<string, unknown>;
  invariant(
    JSON.stringify(Object.keys(modelPrompt).sort()) === JSON.stringify(["chainId", "directRpcEvidence", "requiredComparisonBlock", "target", "task"].sort()),
    "Experiment 2 model prompt contains unexpected inputs"
  );
  invariant(JSON.stringify(modelPrompt.directRpcEvidence) === JSON.stringify(baselineRpc), "Experiment 2 model prompt RPC evidence mismatch");
  invariant(
    !/paid-run-output|security-review-output|indexed-enrichment-output|agentReportHashForPostFreezeScoringOnly/i.test(baselineModel.prompts.user),
    "Experiment 2 model prompt exposes Agent/scoring artifacts"
  );
  invariant(
    baselineCandidate.version === 1 && baselineCandidate.experimentId === "token-risk" && baselineCandidate.status === "non-blind-operator-candidate",
    "Experiment 2 model candidate status mismatch"
  );
  invariant(
    baselineCandidate.input.bundleHash === baselineInputHash &&
      baselineCandidate.input.taskHash === baseline.taskHash &&
      baselineCandidate.input.chainId === report.chainId &&
      sameAddress(baselineCandidate.input.target, report.target.address) &&
      baselineCandidate.input.reportBlock === report.blockNumber,
    "Experiment 2 model candidate input mismatch"
  );
  invariant(baselineCandidate.rawEvidence.rpcArtifactHash === rpcArtifactHash, "Experiment 2 candidate RPC artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.modelArtifactHash === sha256(await readFile(path.join(directory, "baseline-model-raw.json"))), "Experiment 2 candidate model artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.frozenBeforeAgentReportComparison === true, "Experiment 2 candidate was not frozen before Agent comparison");
  invariant(JSON.stringify(parseJsonModelOutput(baselineModel.rawOutput)) === JSON.stringify(baselineCandidate.report), "Experiment 2 frozen model output/candidate report mismatch");
  invariant(baselineCandidate.timing.rpcDurationMs === baselineRpc.timing.durationMs && baselineCandidate.timing.modelDurationMs === baselineModel.timing.wallDurationMs, "Experiment 2 candidate timing mismatch");
  invariant(baselineCandidate.timing.operatorActiveMinutes === 0 && baselineCandidate.timing.operatorType === "automated-codex-orchestrator", "Experiment 2 candidate operator timing disclosure mismatch");
  invariant(JSON.stringify(baselineCandidate.model) === JSON.stringify(baselineModel.model), "Experiment 2 candidate model identity mismatch");
  invariant(JSON.stringify(baselineCandidate.usage) === JSON.stringify(baselineModel.usage), "Experiment 2 candidate usage mismatch");
  invariant(Array.isArray(baselineCandidate.report.facts) && baselineCandidate.report.facts.length > 0, "Experiment 2 candidate facts are missing");
  invariant(Array.isArray(baselineCandidate.report.riskSignals) && baselineCandidate.report.riskSignals.length > 0, "Experiment 2 candidate risk signals are missing");
  invariant(Array.isArray(baselineCandidate.report.coverage.covered) && Array.isArray(baselineCandidate.report.coverage.notCovered), "Experiment 2 candidate coverage is malformed");
  invariant(typeof baselineCandidate.report.recommendation === "string" && baselineCandidate.report.recommendation.length > 0, "Experiment 2 candidate recommendation is missing");
  for (const fact of baselineCandidate.report.facts) {
    invariant(typeof fact.claim === "string" && fact.claim.length > 0, "Experiment 2 candidate fact claim is missing");
    invariant(fact.status === "measured" || fact.status === "unavailable", "Experiment 2 candidate fact status is invalid");
    invariant(typeof fact.source === "string" && fact.source.includes("direct RPC observation"), "Experiment 2 candidate fact source is not direct RPC");
    invariant(fact.observationBlock === baselineRpc.reportBlock || fact.observationBlock === baselineRpc.latestBlock, "Experiment 2 candidate fact has an unobserved block");
  }
  invariant(baselineCandidate.comparisonEligibility.controlledBaseline === false, "Experiment 2 candidate must not complete the controlled baseline");
  invariant(baselineCandidate.limitations.some((item) => item.includes("not the plan's independent human controlled baseline")), "Experiment 2 candidate limitation disclosure is missing");
  const investigator = serviceById(services, "investigator-v1");
  const reviewer = serviceById(services, "risk-verifier-v1");
  invariant(investigator.agentId !== reviewer.agentId, "Experiment 2 Investigator and reviewer share an agent identity");
  invariant(!sameAddress(investigator.service!.provider!, reviewer.service!.provider!), "Experiment 2 Investigator and reviewer share a wallet");
  return {
    paidRun: report,
    missionId: paid.mission.missionId,
    transactionHash: paid.payment.transaction,
    reportHash,
    modelOnlyCandidate: {
      model: `${baselineModel.model.provider}/${baselineModel.model.model}`,
      rpcDurationMs: baselineRpc.timing.durationMs,
      modelDurationMs: baselineModel.timing.wallDurationMs,
      totalTokens: baselineModel.usage.totalTokens,
      historicalMeasured,
      historicalUnavailable,
      riskSignals: baselineCandidate.report.riskSignals.length,
      controlled: false
    }
  };
}

function combinedScopedSource(
  sources: Record<string, string>,
  includedSourceUnits: readonly string[]
): string {
  return [...includedSourceUnits]
    .sort((left, right) => left.localeCompare(right))
    .map((sourceUnit) => {
      const source = sources[sourceUnit];
      invariant(typeof source === "string", `Experiment 3 audit scope references missing source ${sourceUnit}`);
      return `// ===== Source unit: ${sourceUnit} =====\n${source.trimEnd()}`;
    })
    .join("\n\n");
}

async function validateExperiment3(
  services: DynamicServiceEntry[],
  experiment2: Awaited<ReturnType<typeof validateExperiment2>>
): Promise<Record<string, unknown>> {
  const directory = path.join(evidenceRoot, "experiment-3-due-diligence");
  const [securityInput, auditor, verifier, candidate, runtime, baseline, paidDueDiligence] = await Promise.all([
    readJson<SecurityTaskInput>(path.join(directory, "verified-source-input.json")),
    readJson<{
      version: number;
      settlement: { status: string };
      sourceHash: string;
      packageSourceHash: string;
      targetImplementation: string;
      auditScope: {
        kind: string;
        packageSourceHash: string;
        scopeSourceHash: string;
        includedSourceUnits: string[];
        omittedDependencySourceUnits: string[];
        sourceBytes: number;
      };
      engine: { serviceId: string; agentId: string; status: string };
      report: AuditReport;
    }>(path.join(directory, "auditor-output.json")),
    readJson<{
      version: number;
      settlement: { status: string };
      sourceHash: string;
      engine: { serviceId: string; agentId: string };
      report: unknown;
    }>(path.join(directory, "verifier-output.json")),
    loadDueDiligenceCandidate(path.join(directory, "candidate-output.json")),
    readJson<{
      version: number;
      experimentId: string;
      settlement: { status: string };
      source: { sourceHash: string; target: string; reportBlock: number };
      observations: Array<{ status: string; blockNumber: number }>;
    }>(path.join(directory, "runtime-triage-output.json")),
    validateBaselineBundle(
      "evidence/experiment-3-due-diligence",
      "full-due-diligence"
    ),
    loadPaidDueDiligence(path.join(directory, "paid-run-final-output.json"))
  ]);
  invariant(candidate, "Experiment 3 candidate evidence is missing");
  invariant(paidDueDiligence, "Experiment 3 paid due-diligence evidence is missing");
  invariant(securityInput.mode === "verified-source" && securityInput.sources, "Experiment 3 verified multi-file source is missing");
  invariant(securityInput.chainId === 97, "Experiment 3 source is not bound to BNB Testnet");
  invariant(sha256(securityInput.source) === securityInput.sourceHash, "Experiment 3 package source hash mismatch");
  invariant(auditor.version === 1 && auditor.settlement.status === "not-paid", "Experiment 3 Auditor settlement format mismatch");
  invariant(auditor.packageSourceHash === securityInput.sourceHash, "Experiment 3 Auditor package hash mismatch");
  invariant(auditor.auditScope.packageSourceHash === securityInput.sourceHash, "Experiment 3 audit scope package hash mismatch");
  const scopedSource = combinedScopedSource(securityInput.sources, auditor.auditScope.includedSourceUnits);
  invariant(sha256(scopedSource) === auditor.sourceHash, "Experiment 3 scoped source hash mismatch");
  invariant(auditor.auditScope.scopeSourceHash === auditor.sourceHash, "Experiment 3 audit scope hash mismatch");
  invariant(Buffer.byteLength(scopedSource) === auditor.auditScope.sourceBytes, "Experiment 3 scoped source byte count mismatch");
  invariant(securityInput.contractAddress && sameAddress(securityInput.contractAddress, auditor.targetImplementation), "Experiment 3 Auditor implementation mismatch");
  const auditReport = parseAuditReport(JSON.stringify(auditor.report));
  const auditorService = serviceById(services, "auditor-v1");
  const verifierService = serviceById(services, "verifier-v1");
  invariant(auditor.engine.serviceId === "auditor-v1" && auditor.engine.agentId === auditorService.agentId, "Experiment 3 Auditor identity mismatch");
  invariant(auditor.engine.status === "measured", "Experiment 3 Auditor evidence is not measured");
  invariant(verifier.version === 1 && verifier.settlement.status === "not-paid", "Experiment 3 Verifier settlement format mismatch");
  invariant(verifier.sourceHash === securityInput.sourceHash, "Experiment 3 Verifier source hash mismatch");
  invariant(verifier.engine.serviceId === "verifier-v1" && verifier.engine.agentId === verifierService.agentId, "Experiment 3 Verifier identity mismatch");
  const verificationReport = parseVerificationReport(
    JSON.stringify(verifier.report),
    securityInput.sourceHash,
    {
      findingIds: auditReport.vulnerabilities.map((finding) => finding.findingId),
      verifierAgentId: verifier.engine.agentId
    }
  );
  invariant(auditorService.agentId !== verifierService.agentId, "Experiment 3 Auditor and Verifier share an agent identity");
  invariant(!sameAddress(auditorService.service!.provider!, verifierService.service!.provider!), "Experiment 3 Auditor and Verifier share a wallet");
  validateCandidateBindings(candidate, securityInput, auditReport, verificationReport, experiment2);
  invariant(runtime.version === 1 && runtime.experimentId === "full-due-diligence", "Experiment 3 runtime triage format mismatch");
  invariant(runtime.settlement.status === "not-paid", "Experiment 3 runtime triage claims a payment");
  invariant(runtime.source.sourceHash === securityInput.sourceHash, "Experiment 3 runtime source hash mismatch");
  invariant(sameAddress(runtime.source.target, experiment2.paidRun.target.address), "Experiment 3 runtime target mismatch");
  invariant(runtime.source.reportBlock === experiment2.paidRun.blockNumber, "Experiment 3 runtime report block mismatch");
  invariant(runtime.observations.some((observation) => observation.status === "unavailable" && observation.blockNumber === experiment2.paidRun.blockNumber), "Experiment 3 runtime triage must retain the unavailable historical observation");
  invariant(baseline.bindings.chainId === securityInput.chainId, "Experiment 3 baseline chain mismatch");
  invariant(typeof baseline.bindings.proxy === "string" && sameAddress(baseline.bindings.proxy, experiment2.paidRun.target.address), "Experiment 3 baseline proxy mismatch");
  invariant(typeof baseline.bindings.implementation === "string" && securityInput.contractAddress && sameAddress(baseline.bindings.implementation, securityInput.contractAddress), "Experiment 3 baseline implementation mismatch");
  invariant(baseline.bindings.sourceHash === securityInput.sourceHash, "Experiment 3 baseline source hash mismatch");
  invariant(baseline.bindings.reportBlock === experiment2.paidRun.blockNumber, "Experiment 3 baseline block mismatch");
  invariant(baseline.bindings.onchainReportHashForPostFreezeScoringOnly === experiment2.reportHash, "Experiment 3 baseline scoring hash mismatch");
  const baselineInputHash = sha256(await readFile(path.join(directory, "baseline-input.json")));
  const sourceArtifactHash = sha256(await readFile(path.join(directory, "verified-source-input.json")));
  const tokenRiskRpcPath = path.join(evidenceRoot, "experiment-2-token-risk/baseline-rpc-raw.json");
  const [
    failedSlitherAttempt,
    failedModelAttempt,
    failedCandidateAttempt,
    baselineSlither,
    baselineModel,
    baselineCandidate,
    tokenRiskBaselineRpc
  ] = await Promise.all([
    readJson<DueDiligenceBaselineSlitherEvidence>(path.join(directory, "baseline-slither-output.json")),
    readJson<Pick<DueDiligenceBaselineModelEvidence, "status" | "slitherArtifactHash" | "blindness">>(path.join(directory, "baseline-model-raw.json")),
    readJson<{ status: string; comparisonEligibility: { controlledBaseline: boolean } }>(path.join(directory, "baseline-output-candidate.json")),
    readJson<DueDiligenceBaselineSlitherEvidence>(path.join(directory, "baseline-slither-output-attempt-2.json")),
    readJson<DueDiligenceBaselineModelEvidence>(path.join(directory, "baseline-model-raw-attempt-2.json")),
    readJson<DueDiligenceBaselineCandidate>(path.join(directory, "baseline-output-candidate-attempt-2.json")),
    readJson<TokenRiskBaselineRpcEvidence>(tokenRiskRpcPath)
  ]);
  invariant(
    failedSlitherAttempt.version === 1 &&
      failedSlitherAttempt.status === "unavailable" &&
      failedSlitherAttempt.available === true &&
      failedSlitherAttempt.ok === false &&
      typeof failedSlitherAttempt.error === "string" &&
      failedSlitherAttempt.error.length > 0,
    "Experiment 3 failed Slither attempt was not retained transparently"
  );
  invariant(failedModelAttempt.status === "frozen-before-agent-report-comparison", "Experiment 3 first model attempt is not frozen");
  invariant(failedModelAttempt.slitherArtifactHash === sha256(await readFile(path.join(directory, "baseline-slither-output.json"))), "Experiment 3 first model attempt is not bound to the failed Slither artifact");
  invariant(failedModelAttempt.blindness.operatorWasIndependentHuman === false, "Experiment 3 first attempt incorrectly claims an independent human");
  invariant(failedCandidateAttempt.status === "non-blind-operator-candidate" && failedCandidateAttempt.comparisonEligibility.controlledBaseline === false, "Experiment 3 first attempt incorrectly completes the controlled baseline");
  invariant(
    baselineSlither.version === 1 &&
      baselineSlither.experimentId === "full-due-diligence" &&
      baselineSlither.workflow === "ordinary-local-slither-baseline-candidate" &&
      baselineSlither.status === "measured" &&
      baselineSlither.settlement.status === "not-paid" &&
      baselineSlither.available === true &&
      baselineSlither.ok === true,
    "Experiment 3 repaired Slither candidate format/settlement mismatch"
  );
  invariant(baselineSlither.inputBundleHash === baselineInputHash, "Experiment 3 Slither input hash mismatch");
  invariant(baselineSlither.sourceArtifactHash === sourceArtifactHash && baselineSlither.packageSourceHash === securityInput.sourceHash, "Experiment 3 Slither source binding mismatch");
  invariant(baselineSlither.tool.name === "slither" && baselineSlither.tool.version === "0.11.6" && baselineSlither.tool.resultKind === "normalized-wrapper-output", "Experiment 3 Slither identity mismatch");
  invariant(Number.isFinite(baselineSlither.timing.wallDurationMs) && baselineSlither.timing.wallDurationMs > 0, "Experiment 3 Slither timing is invalid");
  invariant(baselineSlither.detections.length > 0, "Experiment 3 repaired Slither candidate has no detections");
  for (const detection of baselineSlither.detections) {
    invariant(typeof detection.id === "string" && detection.id.length > 0, "Experiment 3 Slither detection ID is missing");
    invariant(Number.isSafeInteger(detection.line) && detection.line > 0, "Experiment 3 Slither detection line is invalid");
    invariant(typeof detection.note === "string" && detection.note.length > 0, "Experiment 3 Slither detection note is missing");
  }
  const slitherArtifactPath = path.join(directory, "baseline-slither-output-attempt-2.json");
  const slitherArtifactHash = sha256(await readFile(slitherArtifactPath));
  const rpcArtifactHash = sha256(await readFile(tokenRiskRpcPath));
  invariant(
    baselineModel.version === 1 &&
      baselineModel.experimentId === "full-due-diligence" &&
      baselineModel.status === "frozen-before-agent-report-comparison",
    "Experiment 3 repaired raw model candidate is not frozen"
  );
  invariant(baselineModel.inputBundleHash === baselineInputHash && baselineModel.taskHash === baseline.taskHash, "Experiment 3 repaired model input/task hash mismatch");
  invariant(baselineModel.sourceArtifactHash === sourceArtifactHash && baselineModel.packageSourceHash === securityInput.sourceHash, "Experiment 3 repaired model source binding mismatch");
  invariant(baselineModel.scopedSourceHash === auditor.sourceHash, "Experiment 3 repaired model scoped source mismatch");
  invariant(baselineModel.slitherArtifactHash === slitherArtifactHash && baselineModel.rpcArtifactHash === rpcArtifactHash, "Experiment 3 repaired model tool/RPC hash mismatch");
  invariant(baselineModel.blindness.llmContextExcludedAgentOutputs === true && baselineModel.blindness.llmContextExcludedGroundTruth === true, "Experiment 3 repaired model context was not blind");
  invariant(baselineModel.blindness.operatorWasIndependentHuman === false && baselineModel.blindness.operatorHadPriorProjectContext === true, "Experiment 3 repaired model operator disclosure mismatch");
  invariant(baselineModel.timing.operatorActiveMinutes === 0 && baselineModel.timing.operatorType === "automated-codex-orchestrator", "Experiment 3 repaired model automated timing disclosure mismatch");
  invariant(baselineModel.usage.promptTokens + baselineModel.usage.completionTokens === baselineModel.usage.totalTokens, "Experiment 3 repaired model token usage mismatch");
  const modelPrompt = JSON.parse(baselineModel.prompts.user) as Record<string, unknown>;
  invariant(
    JSON.stringify(Object.keys(modelPrompt).sort()) === JSON.stringify(["bindings", "dependencyManifest", "directRpcEvidence", "localSlitherEvidence", "task", "verifiedFirstPartySource"].sort()),
    "Experiment 3 repaired model prompt contains unexpected inputs"
  );
  invariant(JSON.stringify(modelPrompt.localSlitherEvidence) === JSON.stringify(baselineSlither), "Experiment 3 repaired model prompt Slither evidence mismatch");
  invariant(JSON.stringify(modelPrompt.directRpcEvidence) === JSON.stringify(tokenRiskBaselineRpc), "Experiment 3 repaired model prompt RPC evidence mismatch");
  const promptFirstParty = modelPrompt.verifiedFirstPartySource as { scopeSourceHash?: unknown; combinedSource?: unknown } | undefined;
  invariant(promptFirstParty?.scopeSourceHash === auditor.sourceHash && promptFirstParty.combinedSource === scopedSource, "Experiment 3 repaired model prompt source scope mismatch");
  invariant(
    !/auditor-output|verifier-output|candidate-output|runtime-triage-output|paid-run-output|security-review-output|indexed-enrichment-output|onchainReportHashForPostFreezeScoringOnly/i.test(baselineModel.prompts.user),
    "Experiment 3 repaired model prompt exposes Agent/scoring artifacts"
  );
  invariant(
    baselineCandidate.version === 1 &&
      baselineCandidate.experimentId === "full-due-diligence" &&
      baselineCandidate.status === "non-blind-operator-candidate",
    "Experiment 3 repaired candidate status mismatch"
  );
  invariant(
    baselineCandidate.input.bundleHash === baselineInputHash &&
      baselineCandidate.input.taskHash === baseline.taskHash &&
      baselineCandidate.input.chainId === securityInput.chainId &&
      sameAddress(baselineCandidate.input.proxy, experiment2.paidRun.target.address) &&
      securityInput.contractAddress !== undefined &&
      sameAddress(baselineCandidate.input.implementation, securityInput.contractAddress) &&
      baselineCandidate.input.packageSourceHash === securityInput.sourceHash &&
      baselineCandidate.input.scopedSourceHash === auditor.sourceHash &&
      baselineCandidate.input.reportBlock === experiment2.paidRun.blockNumber,
    "Experiment 3 repaired candidate input mismatch"
  );
  invariant(baselineCandidate.rawEvidence.sourceArtifactHash === sourceArtifactHash, "Experiment 3 repaired candidate source artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.slitherArtifactHash === slitherArtifactHash && baselineCandidate.rawEvidence.rpcArtifactHash === rpcArtifactHash, "Experiment 3 repaired candidate tool/RPC artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.modelArtifactHash === sha256(await readFile(path.join(directory, "baseline-model-raw-attempt-2.json"))), "Experiment 3 repaired candidate model artifact hash mismatch");
  invariant(baselineCandidate.rawEvidence.frozenBeforeAgentReportComparison === true, "Experiment 3 repaired candidate was not frozen before Agent comparison");
  invariant(JSON.stringify(parseJsonModelOutput(baselineModel.rawOutput)) === JSON.stringify(baselineCandidate.report), "Experiment 3 repaired frozen model output/candidate report mismatch");
  invariant(baselineCandidate.timing.slitherDurationMs === baselineSlither.timing.wallDurationMs && baselineCandidate.timing.modelDurationMs === baselineModel.timing.wallDurationMs, "Experiment 3 repaired candidate timing mismatch");
  invariant(baselineCandidate.timing.operatorActiveMinutes === 0 && baselineCandidate.timing.operatorType === "automated-codex-orchestrator", "Experiment 3 repaired candidate operator timing disclosure mismatch");
  invariant(JSON.stringify(baselineCandidate.model) === JSON.stringify(baselineModel.model) && JSON.stringify(baselineCandidate.usage) === JSON.stringify(baselineModel.usage), "Experiment 3 repaired candidate model/usage mismatch");
  invariant(Array.isArray(baselineCandidate.report.findings) && baselineCandidate.report.findings.length > 0, "Experiment 3 repaired candidate findings are missing");
  invariant(["trust", "caution", "do-not-trust", "inconclusive"].includes(baselineCandidate.report.trustDecision), "Experiment 3 repaired candidate trust decision is invalid");
  invariant(Array.isArray(baselineCandidate.report.reasons) && baselineCandidate.report.reasons.length > 0, "Experiment 3 repaired candidate reasons are missing");
  invariant(Array.isArray(baselineCandidate.report.requiredActions) && Array.isArray(baselineCandidate.report.coverage) && Array.isArray(baselineCandidate.report.limitations), "Experiment 3 repaired candidate report arrays are malformed");
  invariant(
    baselineCandidate.postFreezeOperatorReview.status === "non-independent-corrections-recorded" &&
      baselineCandidate.postFreezeOperatorReview.reviewer === "automated-codex-orchestrator" &&
      baselineCandidate.postFreezeOperatorReview.independentHuman === false &&
      baselineCandidate.postFreezeOperatorReview.trustDecisionChanged === false &&
      baselineCandidate.postFreezeOperatorReview.corrections.length === 3,
    "Experiment 3 repaired candidate post-freeze corrections are incomplete"
  );
  invariant(baselineCandidate.postFreezeOperatorReview.corrections.some((correction) => correction.correction.includes("10,005,250,000 U")), "Experiment 3 repaired candidate supply correction is missing");
  invariant(baselineCandidate.postFreezeOperatorReview.corrections.some((correction) => correction.correction.includes("24 raw Slither detections remain unreviewed")), "Experiment 3 repaired candidate Slither caveat correction is missing");
  invariant(baselineCandidate.comparisonEligibility.controlledBaseline === false, "Experiment 3 repaired candidate must not complete the controlled baseline");
  invariant(baselineCandidate.limitations.some((item) => item.includes("not the plan's independent human controlled baseline")), "Experiment 3 repaired candidate limitation disclosure is missing");
  const claudeBlindCandidate = await readJson<{
    version: number;
    experimentId: string;
    artifactKind: string;
    status: string;
    timing: { wallDurationMs: number };
    model: {
      provider: string;
      requestedModel: string;
      totalCostUsdListBasis: number;
      usage: { output_tokens: number };
    };
    isolation: {
      noSessionPersistence: boolean;
      agentOutputsHidden: boolean;
      groundTruthHidden: boolean;
      toolsDenied: string[];
      inputArtifacts: string[];
    };
    review: {
      reviewerType: string;
      blind: boolean;
      trustDecision: string;
      findings: unknown[];
      slitherTriage: Array<{ index: number; verdict: string }>;
      noHumanGroundTruth: boolean;
      limitations: unknown[];
    };
  }>(path.join(directory, "claude-blind-review-candidate.json"));
  invariant(
    claudeBlindCandidate.version === 1 &&
      claudeBlindCandidate.experimentId === "full-due-diligence" &&
      claudeBlindCandidate.artifactKind === "claude-blind-review-candidate" &&
      claudeBlindCandidate.status === "independent-ai-candidate",
    "Experiment 3 Claude blind candidate format mismatch"
  );
  invariant(
    claudeBlindCandidate.model.provider === "Anthropic" &&
      claudeBlindCandidate.model.requestedModel === "sonnet" &&
      Number.isFinite(claudeBlindCandidate.model.totalCostUsdListBasis) &&
      claudeBlindCandidate.model.totalCostUsdListBasis > 0 &&
      claudeBlindCandidate.model.usage.output_tokens > 0 &&
      claudeBlindCandidate.timing.wallDurationMs > 0,
    "Experiment 3 Claude blind candidate timing/model metadata is invalid"
  );
  invariant(
    claudeBlindCandidate.isolation.noSessionPersistence === true &&
      claudeBlindCandidate.isolation.agentOutputsHidden === true &&
      claudeBlindCandidate.isolation.groundTruthHidden === true &&
      claudeBlindCandidate.isolation.toolsDenied.includes("Read") &&
      claudeBlindCandidate.isolation.toolsDenied.includes("WebFetch") &&
      claudeBlindCandidate.isolation.inputArtifacts.includes("evidence/experiment-3-due-diligence/baseline-input.json"),
    "Experiment 3 Claude blind candidate isolation disclosure is incomplete"
  );
  invariant(
    claudeBlindCandidate.review.reviewerType === "independent-ai-candidate" &&
      claudeBlindCandidate.review.blind === true &&
      claudeBlindCandidate.review.noHumanGroundTruth === true &&
      claudeBlindCandidate.review.findings.length > 0 &&
      claudeBlindCandidate.review.limitations.length > 0 &&
      ["trust", "caution", "do-not-trust"].includes(claudeBlindCandidate.review.trustDecision),
    "Experiment 3 Claude blind candidate review disclosure is invalid"
  );
  invariant(
    claudeBlindCandidate.review.slitherTriage.length === baselineSlither.detections.length &&
      claudeBlindCandidate.review.slitherTriage.every((item, index) => item.index === index) &&
      claudeBlindCandidate.review.slitherTriage.every((item) => ["true-positive", "false-positive", "needs-runtime-evidence", "dependency-signal"].includes(item.verdict)),
    "Experiment 3 Claude blind candidate did not adjudicate every Slither detection in order"
  );
  invariant(paidDueDiligence.target.chainId === 97 && sameAddress(paidDueDiligence.target.address, experiment2.paidRun.target.address), "Experiment 3 paid target mismatch");
  const expectedPayments = new Map([
    ["auditor-v1", "500000000000000000"],
    ["verifier-v1", "250000000000000000"],
    ["investigator-v1", "350000000000000000"],
    ["risk-verifier-v1", "250000000000000000"]
  ]);
  invariant(paidDueDiligence.completedServices.length === expectedPayments.size, "Experiment 3 paid service count mismatch");
  invariant(new Set(paidDueDiligence.completedServices.map((payment) => payment.transaction.toLowerCase())).size === expectedPayments.size, "Experiment 3 contains duplicate payment transactions");
  for (const payment of paidDueDiligence.completedServices) {
    invariant(expectedPayments.get(payment.serviceId) === payment.amountRaw, `Experiment 3 ${payment.serviceId} payment amount mismatch`);
    invariant(/^0x[0-9a-fA-F]{64}$/.test(payment.transaction), `Experiment 3 ${payment.serviceId} transaction is invalid`);
  }
  const intendedSpend = paidDueDiligence.completedServices.reduce((sum, payment) => sum + BigInt(payment.amountRaw), 0n);
  const reconciliation = paidDueDiligence.reconciliation;
  invariant(intendedSpend.toString() === reconciliation.intendedNetSpendRaw, "Experiment 3 intended payment sum mismatch");
  invariant(BigInt(reconciliation.grossProviderTransfersRaw) - BigInt(reconciliation.refundRaw) === BigInt(reconciliation.netProviderSpendRaw), "Experiment 3 refund arithmetic mismatch");
  invariant(reconciliation.netProviderSpendRaw === reconciliation.intendedNetSpendRaw && reconciliation.refundRaw === reconciliation.orphanedAuditorSettlementRaw, "Experiment 3 net reconciliation mismatch");
  const [missionStore, receiptEvidence, refundEvidence] = await Promise.all([
    readJson<{ records?: Record<string, unknown> }>(path.join(repositoryRoot, "registry/missions.json")),
    Promise.all([
      "registry/x402-auditor-receipts.json",
      "registry/x402-verifier-receipts.json",
      "registry/x402-investigator-receipts.json"
    ].map((relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8"))).then((parts) => parts.join("\n")),
    readFile(path.join(directory, "orphan-payment-refund-output.json"), "utf8")
  ]);
  invariant(missionStore.records?.[paidDueDiligence.missions.auditAndFindingVerification], "Experiment 3 paid audit mission is not persisted");
  invariant(missionStore.records?.[paidDueDiligence.missions.investigationAndRiskVerification], "Experiment 3 paid investigation mission is not persisted");
  for (const payment of paidDueDiligence.completedServices) {
    invariant(receiptEvidence.includes(payment.transaction), `Experiment 3 receipt stores do not contain ${payment.serviceId} payment`);
  }
  invariant(refundEvidence.includes(reconciliation.orphanedAuditorSettlementTx) && refundEvidence.includes(reconciliation.refundTx), "Experiment 3 orphan/refund evidence is incomplete");
  invariant(
    paidDueDiligence.authorityCleanup.originalAuthorityRevoked === true &&
      paidDueDiligence.authorityCleanup.supplementAuthorityRevoked === true &&
      paidDueDiligence.authorityCleanup.finalPermit2AllowanceRaw === "0" &&
      paidDueDiligence.authorityCleanup.allSessionMaterialDeleted === true &&
      paidDueDiligence.authorityCleanup.postRevokeNegativeTestsRejected === true,
    "Experiment 3 authority cleanup is incomplete"
  );
  return {
    packageSourceHash: securityInput.sourceHash,
    scopedSourceHash: auditor.sourceHash,
    auditorFindings: auditReport.vulnerabilities.length,
    verificationSummary: verificationReport.summary,
    decision: candidate.report.decision.status,
    paidExecution: {
      services: paidDueDiligence.completedServices.length,
      netSpendRaw: reconciliation.netProviderSpendRaw,
      refundBalanced: reconciliation.balanced,
      authoritiesRevoked: true
    },
    modelOnlyCandidate: {
      model: `${baselineModel.model.provider}/${baselineModel.model.model}`,
      slitherVersion: baselineSlither.tool.version,
      slitherDurationMs: baselineSlither.timing.wallDurationMs,
      rawSlitherDetections: baselineSlither.detections.length,
      modelDurationMs: baselineModel.timing.wallDurationMs,
      totalTokens: baselineModel.usage.totalTokens,
      trustDecision: baselineCandidate.report.trustDecision,
      postFreezeCorrections: baselineCandidate.postFreezeOperatorReview.corrections.length,
      controlled: false
    }
  };
}

function validateCandidateBindings(
  candidate: DueDiligenceCandidateEvidence,
  securityInput: SecurityTaskInput,
  auditReport: AuditReport,
  verificationReport: ReturnType<typeof parseVerificationReport>,
  experiment2: Awaited<ReturnType<typeof validateExperiment2>>
): void {
  invariant(candidate.settlement.noNewPayment, "Experiment 3 must not claim an unrecorded new payment");
  invariant(candidate.settlement.existingPaidComponent.missionId === experiment2.missionId, "Experiment 3 reused mission mismatch");
  invariant(candidate.settlement.existingPaidComponent.transactionHash === experiment2.transactionHash, "Experiment 3 reused transaction mismatch");
  invariant(candidate.report.target.sourceHash === securityInput.sourceHash, "Experiment 3 candidate source hash mismatch");
  invariant(securityInput.contractAddress && sameAddress(candidate.report.target.implementation, securityInput.contractAddress), "Experiment 3 candidate implementation mismatch");
  invariant(sameAddress(candidate.report.target.proxy, experiment2.paidRun.target.address), "Experiment 3 candidate proxy mismatch");
  invariant(candidate.report.target.reportBlock === experiment2.paidRun.blockNumber, "Experiment 3 candidate report block mismatch");
  invariant(candidate.report.security.auditorFindings === auditReport.vulnerabilities.length, "Experiment 3 Auditor finding count mismatch");
  invariant(JSON.stringify(candidate.report.security.verificationSummary) === JSON.stringify(verificationReport.summary), "Experiment 3 verification summary mismatch");
  const confirmedHigh = candidate.report.security.findings.filter((finding) =>
    (finding.severity === "critical" || finding.severity === "high") &&
    finding.verificationStatus === "confirmed"
  ).length;
  const partialHigh = candidate.report.security.findings.filter((finding) =>
    (finding.severity === "critical" || finding.severity === "high") &&
    finding.verificationStatus === "partial"
  ).length;
  invariant(candidate.report.security.confirmedCriticalHighFindings === confirmedHigh, "Experiment 3 confirmed high count includes non-confirmed findings");
  invariant(candidate.report.security.partiallyConfirmedCriticalHighFindings === partialHigh, "Experiment 3 partial high count mismatch");
}

async function validateAgentAdvantage(): Promise<Record<string, unknown>> {
  const reportPath = path.join(evidenceRoot, "agent-advantage-report.json");
  const report = await loadAdvantageComparisonBundle(reportPath);
  invariant(report, "TermiX Agent Advantage report is missing");
  invariant(report.officialRequirement.requiresHumanReviewer === false, "TermiX requirement disclosure changed unexpectedly");
  invariant(report.disclosure.independentHumanReviewPerformed === false, "Agent Advantage report falsely claims an independent human review");
  invariant(report.experiments.length === 3, "Agent Advantage report must contain exactly three experiments");
  invariant(new Set(report.experiments.map((experiment) => experiment.experimentId)).size === 3, "Agent Advantage report contains duplicate experiments");

  for (const experiment of report.experiments) {
    invariant(experiment.baseline.status === "measured" && experiment.baseline.workflow === "without-marketplace-agent", `${experiment.experimentId} baseline is not a measured without-Agent run`);
    invariant(experiment.baseline.independentHuman === false, `${experiment.experimentId} baseline falsely claims a human reviewer`);
    invariant(experiment.baseline.blindToAgentOutputs === true, `${experiment.experimentId} baseline was not blind to Agent outputs`);
    invariant(experiment.baseline.durationMs > 0 && experiment.baseline.totalTokens > 0 && experiment.baseline.costUsd >= 0, `${experiment.experimentId} baseline timing/cost is invalid`);
    invariant(experiment.baseline.qualityScore >= 0 && experiment.baseline.qualityScore <= 100, `${experiment.experimentId} baseline quality is outside 0-100`);
    invariant(experiment.agent.qualityScore >= 0 && experiment.agent.qualityScore <= 100, `${experiment.experimentId} Agent quality is outside 0-100`);
    invariant(experiment.comparison.status === "completed", `${experiment.experimentId} comparison is incomplete`);
    invariant(experiment.groundTruth.status === "reviewed" && experiment.groundTruth.independentHuman === false, `${experiment.experimentId} ground-truth disclosure is invalid`);
    for (const [artifact, expectedHash, label] of [
      [experiment.baseline.artifact, experiment.baseline.artifactHash, "baseline"],
      [experiment.groundTruth.artifact, experiment.groundTruth.artifactHash, "ground truth"]
    ] as const) {
      const artifactPath = path.resolve(repositoryRoot, artifact);
      const relative = path.relative(repositoryRoot, artifactPath);
      invariant(!relative.startsWith("..") && !path.isAbsolute(relative), `${experiment.experimentId} ${label} artifact escapes the repository`);
      invariant(sha256(await readFile(artifactPath)) === expectedHash, `${experiment.experimentId} ${label} artifact hash mismatch`);
    }
  }

  const adjudication = await readJson<{
    status: string;
    reviewer: { reviewerType: string; independentHuman: boolean; blindToAgentOutputs: boolean; blindToGroundTruth: boolean };
    source: { rawSlitherArtifact: string; rawSlitherArtifactHash: string; independentReviewArtifact: string; independentReviewArtifactHash: string };
    summary: { total: number; verdictCounts: Record<string, number> };
    adjudications: Array<{ index: number; check: string; sourceUnit: string; lines: number[]; verdict: string }>;
  }>(path.join(evidenceRoot, "experiment-3-due-diligence/slither-adjudication.json"));
  invariant(adjudication.status === "reviewed-by-independent-ai", "Slither adjudication status mismatch");
  invariant(adjudication.reviewer.reviewerType === "independent-ai" && adjudication.reviewer.independentHuman === false, "Slither adjudication falsely claims a human reviewer");
  invariant(adjudication.reviewer.blindToAgentOutputs === true && adjudication.reviewer.blindToGroundTruth === true, "Slither adjudication blindness disclosure mismatch");
  invariant(adjudication.adjudications.length === 24 && adjudication.summary.total === 24, "Slither adjudication must cover all 24 rows");
  invariant(adjudication.adjudications.every((row, index) => row.index === index), "Slither adjudication row order is incomplete");
  invariant(Object.values(adjudication.summary.verdictCounts).reduce((sum, count) => sum + count, 0) === 24, "Slither adjudication verdict totals mismatch");
  for (const [artifact, expectedHash] of [
    [adjudication.source.rawSlitherArtifact, adjudication.source.rawSlitherArtifactHash],
    [adjudication.source.independentReviewArtifact, adjudication.source.independentReviewArtifactHash]
  ] as const) {
    invariant(sha256(await readFile(path.join(repositoryRoot, artifact))) === expectedHash, `Slither adjudication source hash mismatch for ${artifact}`);
  }
  return {
    status: report.status,
    completedComparisons: report.experiments.length,
    slitherRowsAdjudicated: adjudication.adjudications.length,
    independentHumanReviewPerformed: false
  };
}

async function validatePaidStability(): Promise<Record<string, unknown>> {
  const artifact = await readJson<{
    version: number;
    artifactKind: string;
    status: string;
    chainId: number;
    authorityId: string;
    sourceHash: string;
    startedAt: string;
    completedAt: string;
    actualSpendRaw: string;
    medianDurationMs: number;
    expectedEconomics: {
      chainId: number;
      asset: string;
      runs: number;
      intendedSpendRaw: string;
      maximumAuthoritySpendRaw: string;
      auditor: { serviceId: string; recipient: string; amountRaw: string };
      verifier: { serviceId: string; recipient: string; amountRaw: string };
    };
    runs: Array<{
      runNumber: number;
      status: string;
      deliveryMode: string;
      missionId: string;
      durationMs: number;
      sourceHash: string;
      receiptsVerified: boolean;
      payments: {
        auditor: { serviceId: string; recipient: string; amountRaw: string; assetAddress: string; transaction: string };
        verifier: { serviceId: string; recipient: string; amountRaw: string; assetAddress: string; transaction: string };
      };
      verifier: { engine?: { name?: string; version?: string } };
    }>;
  }>(path.join(evidenceRoot, "stability/three-consecutive-paid-runs.json"));
  const expectedAuthorityId = "agora-termix-stability-20260902";
  const expectedAsset = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
  const expectedAuditor = "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527";
  const expectedVerifier = "0x7EA7fBf92d5355957C187976BFE7c5788B2F70bb";
  const expectedSourceHash = sha256(
    (await readFile(path.join(evidenceRoot, "experiment-1-contract-audit/VulnerableVault.sol"), "utf8")).trim()
  );

  invariant(artifact.version === 1 && artifact.artifactKind === "three-consecutive-paid-rehearsals", "Paid stability artifact format mismatch");
  invariant(artifact.status === "completed" && artifact.chainId === 97, "Paid stability run is not completed on BNB Testnet");
  invariant(artifact.authorityId === expectedAuthorityId, "Paid stability Authority mismatch");
  invariant(artifact.sourceHash === expectedSourceHash, "Paid stability source hash mismatch");
  invariant(Date.parse(artifact.completedAt) > Date.parse(artifact.startedAt), "Paid stability timing window is invalid");
  invariant(artifact.expectedEconomics.runs === 3, "Paid stability run count preview mismatch");
  invariant(artifact.expectedEconomics.chainId === 97 && sameAddress(artifact.expectedEconomics.asset, expectedAsset), "Paid stability asset preview mismatch");
  invariant(artifact.expectedEconomics.intendedSpendRaw === "2250000000000000000" && artifact.expectedEconomics.maximumAuthoritySpendRaw === "2250000000000000000", "Paid stability cap/spend preview mismatch");
  invariant(artifact.expectedEconomics.auditor.serviceId === "auditor-v1" && sameAddress(artifact.expectedEconomics.auditor.recipient, expectedAuditor) && artifact.expectedEconomics.auditor.amountRaw === "500000000000000000", "Paid stability Auditor preview mismatch");
  invariant(artifact.expectedEconomics.verifier.serviceId === "verifier-v1" && sameAddress(artifact.expectedEconomics.verifier.recipient, expectedVerifier) && artifact.expectedEconomics.verifier.amountRaw === "250000000000000000", "Paid stability Verifier preview mismatch");
  invariant(artifact.runs.length === 3, "Paid stability must contain exactly three runs");

  const transactions: string[] = [];
  const missionIds: string[] = [];
  const durations: number[] = [];
  for (const [index, run] of artifact.runs.entries()) {
    invariant(run.runNumber === index + 1 && run.status === "completed", `Paid stability run ${index + 1} status/order mismatch`);
    invariant(run.deliveryMode === (index === 2 ? "settlement-reconciled" : "live-response"), `Paid stability run ${index + 1} delivery disclosure mismatch`);
    invariant(run.sourceHash === expectedSourceHash && run.receiptsVerified === true, `Paid stability run ${index + 1} source/receipt mismatch`);
    invariant(Number.isSafeInteger(run.durationMs) && run.durationMs > 0, `Paid stability run ${index + 1} duration is invalid`);
    invariant(run.payments.auditor.serviceId === "auditor-v1" && sameAddress(run.payments.auditor.recipient, expectedAuditor) && sameAddress(run.payments.auditor.assetAddress, expectedAsset) && run.payments.auditor.amountRaw === "500000000000000000", `Paid stability run ${index + 1} Auditor settlement mismatch`);
    invariant(run.payments.verifier.serviceId === "verifier-v1" && sameAddress(run.payments.verifier.recipient, expectedVerifier) && sameAddress(run.payments.verifier.assetAddress, expectedAsset) && run.payments.verifier.amountRaw === "250000000000000000", `Paid stability run ${index + 1} Verifier settlement mismatch`);
    invariant(/^0x[0-9a-fA-F]{64}$/.test(run.payments.auditor.transaction) && /^0x[0-9a-fA-F]{64}$/.test(run.payments.verifier.transaction), `Paid stability run ${index + 1} transaction hash is invalid`);
    invariant(run.verifier.engine?.name === "slither" && run.verifier.engine.version === "0.11.6", `Paid stability run ${index + 1} did not use Slither 0.11.6`);
    transactions.push(run.payments.auditor.transaction, run.payments.verifier.transaction);
    missionIds.push(run.missionId);
    durations.push(run.durationMs);
  }
  invariant(new Set(missionIds).size === 3 && new Set(transactions).size === 6, "Paid stability missions or transactions are not unique");
  invariant(artifact.actualSpendRaw === "2250000000000000000", "Paid stability actual spend mismatch");
  const sortedDurations = [...durations].sort((left, right) => left - right);
  invariant(artifact.medianDurationMs === sortedDurations[1], "Paid stability median duration mismatch");

  const missionStore = await readJson<{ records?: Record<string, { authorityId?: string; status?: string; result?: { paymentTx?: string; receiptVerified?: boolean; verification?: { paymentTx?: string; receiptVerified?: boolean } } }> }>(
    path.join(repositoryRoot, "registry/missions.json")
  );
  for (const run of artifact.runs) {
    const mission = missionStore.records?.[run.missionId];
    invariant(mission?.status === "completed" && mission.authorityId === expectedAuthorityId, `Paid stability mission ${run.missionId} is not completed under the approved Authority`);
    invariant(mission.result?.paymentTx === run.payments.auditor.transaction && mission.result.receiptVerified === true, `Paid stability mission ${run.missionId} Auditor evidence mismatch`);
    invariant(mission.result.verification?.paymentTx === run.payments.verifier.transaction && mission.result.verification.receiptVerified === true, `Paid stability mission ${run.missionId} Verifier evidence mismatch`);
  }

  const authorityStore = await readJson<{ records?: Record<string, { authority?: { status?: string; spendLimits?: Array<{ limit?: string }> }; revocation?: { sessionMaterialDeleted?: boolean; negativeTest?: { rejected?: boolean }; checkerApprovalTxHash?: string; permit2AllowanceTxHash?: string; sessionRevokeTxHash?: string } }> }>(
    path.join(repositoryRoot, "registry/authority-evidence.json")
  );
  const authority = authorityStore.records?.[expectedAuthorityId];
  invariant(authority?.authority?.status === "revoked" && authority.authority.spendLimits?.[0]?.limit === "2250000000000000000", "Paid stability Authority is not revoked with the approved cap");
  invariant(authority.revocation?.sessionMaterialDeleted === true && authority.revocation.negativeTest?.rejected === true, "Paid stability revoke cleanup/negative test mismatch");
  invariant([authority.revocation?.checkerApprovalTxHash, authority.revocation?.permit2AllowanceTxHash, authority.revocation?.sessionRevokeTxHash].every((hash) => typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)), "Paid stability revoke transaction evidence is incomplete");
  const sessionStore = await readJson<{ records?: Record<string, unknown> }>(
    path.join(repositoryRoot, "registry/altana-sessions.json")
  );
  invariant(!sessionStore.records?.[expectedAuthorityId], "Revoked paid stability Session material still exists");

  return {
    authorityId: artifact.authorityId,
    runs: artifact.runs.length,
    settlements: transactions.length,
    actualSpendRaw: artifact.actualSpendRaw,
    revoked: true,
    negativeTestRejected: true
  };
}

async function validateLatestBackendAcceptance(): Promise<Record<string, unknown>> {
  const authorityId = "agora-v2-sentinel-20260904-01";
  const asset = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
  const auditorTx = "0x89b0e476005ec70e116abd7ae31f0d97e2118c5b89ecc6505feb517cfea51522";
  const verifierTx = "0x5d7bb2d1407df3e6d1c87b970e3da1bee3e1a198a0ce03d3f9d4059dddcc4b95";
  const sentinelTx = "0xbca135b7bf3d8a65d5bd1670817ca6bfea8eb3766213ee08c4c47d539f485bf1";
  const auditor = await readJson<{
    version: number; artifactKind: string; status: string; deliveryMode: string; authorityId: string;
    missionId: string; sourceHash: string; receiptsVerified: boolean; auditorFindings: number;
    economics: {
      intendedSpendRaw: string;
      auditor: { serviceId: string; provider: string; amountRaw: string; asset: string; transaction: string };
      verifier: { serviceId: string; provider: string; amountRaw: string; asset: string; transaction: string };
    };
    verifier: { engine?: { name?: string; version?: string } };
  }>(path.join(evidenceRoot, "stability/auditor-verifier-paid-acceptance.json"));
  invariant(auditor.version === 1 && auditor.artifactKind === "auditor-verifier-paid-acceptance" && auditor.status === "completed", "Latest Auditor/Verifier acceptance format mismatch");
  invariant(auditor.authorityId === authorityId && auditor.deliveryMode === "settlement-recovered", "Latest Auditor/Verifier recovery disclosure mismatch");
  invariant(auditor.economics.intendedSpendRaw === "750000000000000000" && auditor.receiptsVerified && auditor.auditorFindings === 3, "Latest Auditor/Verifier result mismatch");
  invariant(auditor.economics.auditor.serviceId === "auditor-v1" && auditor.economics.auditor.amountRaw === "500000000000000000" && sameAddress(auditor.economics.auditor.asset, asset) && auditor.economics.auditor.transaction === auditorTx, "Latest Auditor payment mismatch");
  invariant(auditor.economics.verifier.serviceId === "verifier-v1" && auditor.economics.verifier.amountRaw === "250000000000000000" && sameAddress(auditor.economics.verifier.asset, asset) && auditor.economics.verifier.transaction === verifierTx, "Latest Verifier payment mismatch");
  invariant(auditor.verifier.engine?.name === "slither" && auditor.verifier.engine.version === "0.11.6", "Latest Verifier did not use Slither 0.11.6");

  const sentinel = await readJson<{
    version: number; artifactKind: string; status: string; authorityId: string; missionId: string;
    service: { id: string; provider: string }; economics: { chainId: number; asset: string; amountRaw: string; transaction: string };
    requestHash: string; receiptVerified: boolean; sourceHash: string; reportSummary: { vulnerabilityCount: number };
  }>(path.join(evidenceRoot, "stability/sentinel-paid-acceptance.json"));
  invariant(sentinel.version === 1 && sentinel.artifactKind === "sentinel-paid-acceptance" && sentinel.status === "completed", "Sentinel acceptance format mismatch");
  invariant(sentinel.authorityId === authorityId && sentinel.service.id === "sentinel-audit-v1" && sameAddress(sentinel.service.provider, "0x1Ef8eEb640e60d5d3Bc3eFe1A4b2fFCd64132c2C"), "Sentinel identity mismatch");
  invariant(sentinel.economics.chainId === 97 && sameAddress(sentinel.economics.asset, asset) && sentinel.economics.amountRaw === "400000000000000000" && sentinel.economics.transaction === sentinelTx, "Sentinel payment mismatch");
  invariant(sentinel.receiptVerified && sentinel.reportSummary.vulnerabilityCount === 4 && sentinel.sourceHash === auditor.sourceHash, "Sentinel result/source mismatch");

  const missions = await readJson<{ records?: Record<string, { status?: string; source?: string; authorityId?: string; result?: { paymentTx?: string; receiptVerified?: boolean; verification?: { paymentTx?: string; receiptVerified?: boolean } } }> }>(path.join(repositoryRoot, "registry/missions.json"));
  const mission = missions.records?.[auditor.missionId];
  invariant(mission?.status === "completed" && mission.source === "recovered-evidence" && mission.authorityId === authorityId, "Latest paid mission is not a disclosed completed recovery");
  invariant(mission.result?.paymentTx === auditorTx && mission.result.receiptVerified === true && mission.result.verification?.paymentTx === verifierTx && mission.result.verification.receiptVerified === true, "Latest paid mission receipt bindings mismatch");
  const runs = await readJson<{ records?: Record<string, { missionId?: string; status?: string; error?: unknown; result?: { paymentTx?: string; verification?: { paymentTx?: string } } }> }>(path.join(repositoryRoot, "registry/runs.json"));
  const run = Object.values(runs.records ?? {}).find((record) => record.missionId === auditor.missionId);
  invariant(run?.status === "completed" && run.error === undefined && run.result?.paymentTx === auditorTx && run.result.verification?.paymentTx === verifierTx, "Latest durable run terminal state is not reconciled with the recovered mission");

  const sentinelReceipts = await readJson<{ records?: Record<string, { serviceId?: string; payment?: { transaction?: string }; response?: { result?: string; receipt?: Parameters<typeof verifyReceiptTool>[0] } }> }>(path.join(repositoryRoot, "registry/x402-sentinel-receipts.json"));
  const sentinelRecord = Object.values(sentinelReceipts.records ?? {}).find((record) => record.payment?.transaction === sentinelTx);
  invariant(sentinelRecord?.serviceId === "sentinel-audit-v1" && typeof sentinelRecord.response?.result === "string" && sentinelRecord.response.receipt, "Sentinel merchant receipt is missing");
  invariant(verifyReceiptTool(sentinelRecord.response.receipt, { result: sentinelRecord.response.result, provider: sentinel.service.provider }).isValid, "Sentinel merchant receipt signature is invalid");
  invariant(parseAuditReport(sentinelRecord.response.result).vulnerabilities.length === 4, "Sentinel merchant result is invalid");

  const authorityStore = await readJson<{ records?: Record<string, { authority?: { status?: string; spendLimits?: Array<{ limit?: string }>; allowedCalls?: Array<{ to?: string }> }; lifecycle?: { operation?: string; phase?: string; transactions?: Record<string, string> }; revocation?: { sessionMaterialDeleted?: boolean; negativeTest?: { rejected?: boolean }; checkerApprovalTxHash?: string; permit2AllowanceTxHash?: string; sessionRevokeTxHash?: string } }> }>(path.join(repositoryRoot, "registry/authority-evidence.json"));
  const authority = authorityStore.records?.[authorityId];
  invariant(authority?.authority?.status === "revoked" && authority.authority.spendLimits?.[0]?.limit === "1150000000000000000", "Latest backend Authority is not revoked with the exact cap");
  invariant(authority.authority.allowedCalls?.length === 3 && authority.lifecycle?.operation === "revoke" && authority.lifecycle.phase === "complete", "Latest backend Authority lifecycle mismatch");
  invariant(authority.revocation?.sessionMaterialDeleted === true && authority.revocation.negativeTest?.rejected === true, "Latest backend Authority cleanup/negative test mismatch");
  invariant([authority.revocation?.checkerApprovalTxHash, authority.revocation?.permit2AllowanceTxHash, authority.revocation?.sessionRevokeTxHash].every((hash) => typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)), "Latest backend Authority revoke transactions are incomplete");
  const sessions = await readJson<{ records?: Record<string, unknown> }>(path.join(repositoryRoot, "registry/altana-sessions.json"));
  invariant(!sessions.records?.[authorityId], "Latest revoked Authority Session material still exists");
  return { authorityId, spendRaw: "1150000000000000000", settlements: 3, sentinelAccepted: true, revoked: true, negativeTestRejected: true };
}

async function main(): Promise<void> {
  const dynamicRegistry = await readJson<{ services?: DynamicServiceEntry[] }>(
    path.join(repositoryRoot, "registry/dynamic-services.json")
  );
  const services = dynamicRegistry.services ?? [];
  const [experiment1, experiment2, secretCheckedFiles, agentAdvantage, paidStability, latestBackendAcceptance] = await Promise.all([
    validateExperiment1(),
    validateExperiment2(services),
    validateNoSecretFields(evidenceRoot),
    validateAgentAdvantage(),
    validatePaidStability(),
    validateLatestBackendAcceptance()
  ]);
  const experiment3 = await validateExperiment3(services, experiment2);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    chainId: 97,
    publicEvidenceJsonFilesChecked: secretCheckedFiles,
    experiments: {
      contractAudit: experiment1,
      tokenRisk: {
        missionId: experiment2.missionId,
        transactionHash: experiment2.transactionHash,
        reportHash: experiment2.reportHash,
        review: "bound",
        enrichment: "bound",
        modelOnlyCandidate: experiment2.modelOnlyCandidate
      },
      dueDiligence: experiment3
    },
    agentAdvantage,
    paidStability,
    latestBackendAcceptance
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Evidence validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
