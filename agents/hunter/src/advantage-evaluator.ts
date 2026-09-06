import { readFile } from "node:fs/promises";
import type { TokenRiskVerificationReport } from "@rebel/shared";

export interface AdvantageComparisonBundle {
  version: 1;
  artifactKind: "termix-agent-advantage-report";
  status: "complete-for-official-termix";
  officialRequirement: {
    source: string;
    requiresHumanReviewer: false;
    interpretation: string;
  };
  disclosure: {
    independentHumanReviewPerformed: false;
    statement: string;
  };
  experiments: Array<{
    experimentId: "contract-audit" | "token-risk" | "full-due-diligence";
    baseline: {
      status: "measured";
      workflow: "without-marketplace-agent";
      reviewerType: "automated-operator" | "independent-ai";
      independentHuman: false;
      blindToAgentOutputs: boolean;
      model: { provider: string; model: string };
      durationMs: number;
      totalTokens: number;
      costUsd: number;
      costBasis: string;
      qualityScore: number;
      qualityScale: 100;
      qualitySummary: string;
      artifact: string;
      artifactHash: string;
    };
    agent: {
      qualityScore: number;
      qualityScale: 100;
      qualitySummary: string;
      evidence: string[];
    };
    comparison: {
      status: "completed";
      qualityDelta: number;
      durationDeltaMs: number;
      result: string;
      costCaveat: string;
    };
    groundTruth: {
      status: "reviewed";
      benchmarkId: string;
      sourceHash: string;
      findings: number;
      reviewerType: "deterministic-operator" | "independent-ai";
      independentHuman: false;
      reviewMethod: string[];
      artifact: string;
      artifactHash: string;
    };
  }>;
}

export interface AuditGroundTruthFinding {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  lines: string;
  matchingFindingIds: string[];
  rationale: string;
}

export interface AuditGroundTruthManifest {
  version: 1;
  benchmarkId: string;
  reviewStatus: "candidate" | "reviewed";
  sourceHash: string;
  acceptedLegacyInputHashes?: string[];
  reviewedAt?: string;
  reviewMethod?: string[];
  findings: AuditGroundTruthFinding[];
}

export interface AuditQualityMetrics {
  benchmarkId: string;
  groundTruthSourceHash: string;
  groundTruthFindings: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  evidenceCompleteness: number;
  matchedGroundTruthIds: string[];
  missedGroundTruthIds: string[];
}

export interface AuditToolBaselineEvidence {
  version: 1;
  experimentId: "contract-audit";
  baselineKind: "tool-only-static-analysis";
  controlledHumanBaselineStatus: "pending";
  input: {
    sourceFile: string;
    sourceHash: string;
    benchmarkId: string;
  };
  runtime: {
    tool: string;
    version: string;
    command: string;
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  cost: {
    currency: string;
    amount: number;
    basis: string;
  };
  output: {
    ok: boolean;
    available: boolean;
    version?: string;
    detections: Array<{ id: string }>;
  };
  quality: AuditQualityMetrics;
  limitations: string[];
}

export interface TokenRiskSecurityReviewEvidence {
  version: 1;
  experimentId: "token-risk";
  reviewKind: "independent-security-agent-rpc-replay";
  settlement: {
    status: "not-paid";
    reason: string;
  };
  source: {
    missionId: string;
    evidenceFile: string;
    reportHash: string;
    blockNumber: number;
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  reviewer: {
    serviceId: string;
    engine: TokenRiskVerificationReport["engine"];
  };
  review: TokenRiskVerificationReport;
}

export interface PaidDueDiligenceEvidence {
  version: 1;
  experimentId: "full-due-diligence";
  status: "completed-after-reconciliation";
  target: { chainId: number; address: string };
  completedServices: Array<{
    serviceId: "auditor-v1" | "verifier-v1" | "investigator-v1" | "risk-verifier-v1";
    amountRaw: string;
    transaction: string;
  }>;
  reconciliation: {
    orphanedAuditorSettlementRaw: string;
    orphanedAuditorSettlementTx: string;
    refundRaw: string;
    refundTx: string;
    grossProviderTransfersRaw: string;
    netProviderSpendRaw: string;
    intendedNetSpendRaw: string;
    balanced: true;
  };
  missions: {
    auditAndFindingVerification: string;
    investigationAndRiskVerification: string;
  };
  authorityCleanup: {
    originalAuthorityRevoked: true;
    supplementAuthorityRevoked: true;
    finalPermit2AllowanceRaw: "0";
    allSessionMaterialDeleted: true;
    postRevokeNegativeTestsRejected: true;
  };
}

export interface TokenRiskEnrichmentEvidence {
  version: 1;
  experimentId: "token-risk";
  enrichmentKind: "post-run-index-and-dex-enrichment";
  settlement: {
    status: "not-paid";
    reason: string;
  };
  source: {
    missionId: string;
    evidenceFile: string;
    reportHash: string;
    blockNumber: number;
    target: string;
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  dex: {
    version: 1;
    chainId: number;
    target: string;
    blockNumber: number;
    observedAt: string;
    engine: {
      name: "agora-token-risk-dex-enrichment";
      version: "1";
      method: "historical-eth-call";
      endpoint: string;
    };
    scope: {
      venue: "PancakeSwap";
      versions: ["v2", "v3"];
      quoteAsset: "WBNB";
    };
    wrappedNative: string;
    v2: {
      factory: string;
      router: string;
      pair: string;
      pairExists: boolean;
      reserveTokenRaw?: string;
      reserveWrappedNativeRaw?: string;
      tokenReservePartsPerBillionOfSupply?: string;
    };
    v3: {
      factory: string;
      pools: Array<{
        fee: number;
        pool: string;
        exists: boolean;
        liquidityRaw?: string;
      }>;
    };
    quote: {
      status: "quote-only" | "unavailable";
      inputTokenRaw: string;
      outputWrappedNativeRaw?: string;
      path: [string, string];
      limitation: string;
    };
    coverage: {
      liquidity: "measured";
      sellability: "partial" | "measured";
    };
    interpretation: string;
    limitations: string[];
  };
  indexedData: {
    holderConcentration: {
      status: "unavailable";
      reason: string;
    } | {
      status: "measured";
      evidenceFile: string;
      snapshotBlock: number;
      holderCount: number;
      totalSupplyRaw: string;
      top1PartsPerMillion: number;
      top5PartsPerMillion: number;
      top10PartsPerMillion: number;
      validation: {
        complete: true;
        method: string;
        blockBalanceSumRaw: string;
        totalSupplyRaw: string;
        balanceReadFailures: 0;
        missingSupplyRaw: "0";
      };
    };
    recentTransactions:
      | {
          status: "unavailable";
          reason: string;
        }
      | {
          status: "measured";
          observedTransfers: number;
          blockRange: { from: number; to: number };
          activity: {
            transfers: number;
            uniqueTransactions: number;
            mints: number;
            burns: number;
            uniqueSenders: number;
            uniqueRecipients: number;
            transferredRaw: string;
            firstBlock?: number;
            lastBlock?: number;
          };
        };
    attempts: Array<{
      source: string;
      dimension: string;
      endpoint: string;
      status: string;
      detail: string;
    }>;
  };
  sellabilityExecution?: {
    status: "confirmed";
    evidenceFile: string;
    observedAt: string;
    blockNumber: number;
    venue: "PancakeSwap V2";
    inputAmountRaw: string;
    outputAmountRaw: string;
    slippageBps: number;
    minimumOutRaw: string;
    approvalTransaction: string;
    swapTransaction: string;
    routerAllowanceAfterSwapRaw: "0";
  };
  coverage: {
    originalMeasured: number;
    postRunMeasured: number;
    total: number;
    added: string[];
    partial: string[];
    unavailable: string[];
  };
  limitations: string[];
}

interface ModelOnlyCandidateCommon {
  status: "model-only-candidate";
  experimentId: "contract-audit" | "token-risk" | "full-due-diligence";
  model: { provider: string; model: string };
  durationMs: number;
  totalTokens: number;
  controlledBaseline: false;
  independentHuman: false;
  costUsd: null;
  limitations: string[];
}

export type ModelOnlyBaselineCandidate =
  | (ModelOnlyCandidateCommon & {
      kind: "contract-audit";
      outcome: {
        findings: number;
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
        severityAccuracy: number;
      };
    })
  | (ModelOnlyCandidateCommon & {
      kind: "token-risk";
      outcome: {
        rpcDurationMs: number;
        modelDurationMs: number;
        riskSignals: number;
        recommendation: string;
      };
    })
  | (ModelOnlyCandidateCommon & {
      kind: "due-diligence";
      outcome: {
        slitherDurationMs: number;
        rawSlitherDetections: number;
        trustDecision: string;
        postFreezeCorrections: number;
      };
    });

interface AuditorFinding {
  findingId?: unknown;
  evidence?: {
    file?: unknown;
    lines?: unknown;
    snippet?: unknown;
  };
}

function parseAuditorFindings(result: string): AuditorFinding[] {
  try {
    const parsed = JSON.parse(result) as { vulnerabilities?: unknown };
    return Array.isArray(parsed.vulnerabilities)
      ? parsed.vulnerabilities.filter((finding): finding is AuditorFinding =>
          Boolean(finding) && typeof finding === "object")
      : [];
  } catch {
    return [];
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export function scoreAuditAgainstGroundTruth(input: {
  result: string;
  sourceHash?: string;
  groundTruth: AuditGroundTruthManifest;
}): AuditQualityMetrics | undefined {
  if (input.groundTruth.reviewStatus !== "reviewed") return undefined;
  const acceptedHashes = new Set([
    input.groundTruth.sourceHash,
    ...(input.groundTruth.acceptedLegacyInputHashes ?? [])
  ]);
  if (!input.sourceHash || !acceptedHashes.has(input.sourceHash)) return undefined;

  const findings = parseAuditorFindings(input.result);
  const findingIds = new Set(
    findings
      .map((finding) => finding.findingId)
      .filter((findingId): findingId is string => typeof findingId === "string" && Boolean(findingId))
  );
  const matchedGroundTruth = input.groundTruth.findings.filter((truth) =>
    truth.matchingFindingIds.some((findingId) => findingIds.has(findingId))
  );
  const knownFindingIds = new Set(
    input.groundTruth.findings.flatMap((truth) => truth.matchingFindingIds)
  );
  const falsePositives = [...findingIds].filter((findingId) => !knownFindingIds.has(findingId)).length;
  const completeEvidence = findings.filter((finding) =>
    typeof finding.evidence?.file === "string" && Boolean(finding.evidence.file) &&
    typeof finding.evidence?.lines === "string" && Boolean(finding.evidence.lines) &&
    typeof finding.evidence?.snippet === "string" && Boolean(finding.evidence.snippet)
  ).length;
  const truePositives = matchedGroundTruth.length;
  const falseNegatives = input.groundTruth.findings.length - truePositives;
  return {
    benchmarkId: input.groundTruth.benchmarkId,
    groundTruthSourceHash: input.groundTruth.sourceHash,
    groundTruthFindings: input.groundTruth.findings.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, input.groundTruth.findings.length),
    evidenceCompleteness: ratio(completeEvidence, findings.length),
    matchedGroundTruthIds: matchedGroundTruth.map((finding) => finding.id),
    missedGroundTruthIds: input.groundTruth.findings
      .filter((truth) => !matchedGroundTruth.includes(truth))
      .map((finding) => finding.id)
  };
}

export async function loadAuditGroundTruth(
  manifestPath: string
): Promise<AuditGroundTruthManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as AuditGroundTruthManifest;
    if (
      parsed.version !== 1 ||
      !parsed.benchmarkId ||
      !parsed.sourceHash ||
      !Array.isArray(parsed.findings) ||
      (parsed.reviewStatus !== "candidate" && parsed.reviewStatus !== "reviewed")
    ) {
      throw new Error("Audit ground-truth manifest has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadAuditToolBaseline(
  evidencePath: string
): Promise<AuditToolBaselineEvidence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as AuditToolBaselineEvidence;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== "contract-audit" ||
      parsed.baselineKind !== "tool-only-static-analysis" ||
      parsed.controlledHumanBaselineStatus !== "pending" ||
      !parsed.input?.sourceHash ||
      !parsed.input.benchmarkId ||
      !parsed.runtime?.tool ||
      !parsed.runtime.version ||
      !Number.isFinite(parsed.timing?.durationMs) ||
      parsed.timing.durationMs < 0 ||
      !Array.isArray(parsed.output?.detections) ||
      !parsed.quality?.groundTruthSourceHash ||
      !Array.isArray(parsed.limitations)
    ) {
      throw new Error("Audit tool baseline evidence has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadTokenRiskSecurityReview(
  evidencePath: string
): Promise<TokenRiskSecurityReviewEvidence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as TokenRiskSecurityReviewEvidence;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== "token-risk" ||
      parsed.reviewKind !== "independent-security-agent-rpc-replay" ||
      parsed.settlement?.status !== "not-paid" ||
      !parsed.source?.missionId ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.source.reportHash) ||
      !Number.isSafeInteger(parsed.source.blockNumber) ||
      !Number.isFinite(parsed.timing?.durationMs) ||
      parsed.timing.durationMs < 0 ||
      !parsed.reviewer?.serviceId ||
      parsed.review?.version !== 1 ||
      parsed.review.engine?.method !== "independent-rpc-replay" ||
      parsed.review.sourceReportHash !== parsed.source.reportHash ||
      parsed.review.blockNumber !== parsed.source.blockNumber ||
      !Array.isArray(parsed.review.checks) ||
      parsed.review.summary?.total !== parsed.review.checks.length
    ) {
      throw new Error("Token-risk Security Agent review evidence has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadPaidDueDiligence(
  evidencePath: string
): Promise<PaidDueDiligenceEvidence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as PaidDueDiligenceEvidence;
    const expectedServices = new Set([
      "auditor-v1",
      "verifier-v1",
      "investigator-v1",
      "risk-verifier-v1"
    ]);
    const serviceIds = new Set(parsed.completedServices?.map((service) => service.serviceId));
    const completedNetSpend = parsed.completedServices?.reduce(
      (sum, service) => sum + (/^\d+$/.test(service.amountRaw) ? BigInt(service.amountRaw) : 0n),
      0n
    );
    const reconciliation = parsed.reconciliation;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== "full-due-diligence" ||
      parsed.status !== "completed-after-reconciliation" ||
      parsed.target?.chainId !== 97 ||
      !/^0x[0-9a-fA-F]{40}$/.test(parsed.target.address) ||
      !Array.isArray(parsed.completedServices) ||
      parsed.completedServices.length !== expectedServices.size ||
      [...expectedServices].some((serviceId) => !serviceIds.has(serviceId as never)) ||
      parsed.completedServices.some((service) =>
        !/^\d+$/.test(service.amountRaw) ||
        !/^0x[0-9a-fA-F]{64}$/.test(service.transaction)
      ) ||
      !reconciliation ||
      reconciliation.balanced !== true ||
      !/^\d+$/.test(reconciliation.grossProviderTransfersRaw) ||
      !/^\d+$/.test(reconciliation.refundRaw) ||
      !/^\d+$/.test(reconciliation.netProviderSpendRaw) ||
      !/^\d+$/.test(reconciliation.intendedNetSpendRaw) ||
      BigInt(reconciliation.grossProviderTransfersRaw) - BigInt(reconciliation.refundRaw) !==
        BigInt(reconciliation.netProviderSpendRaw) ||
      BigInt(reconciliation.netProviderSpendRaw) !== BigInt(reconciliation.intendedNetSpendRaw) ||
      completedNetSpend !== BigInt(reconciliation.netProviderSpendRaw) ||
      !/^0x[0-9a-fA-F]{64}$/.test(reconciliation.orphanedAuditorSettlementTx) ||
      !/^0x[0-9a-fA-F]{64}$/.test(reconciliation.refundTx) ||
      !parsed.missions?.auditAndFindingVerification ||
      !parsed.missions.investigationAndRiskVerification ||
      parsed.authorityCleanup?.originalAuthorityRevoked !== true ||
      parsed.authorityCleanup.supplementAuthorityRevoked !== true ||
      parsed.authorityCleanup.finalPermit2AllowanceRaw !== "0" ||
      parsed.authorityCleanup.allSessionMaterialDeleted !== true ||
      parsed.authorityCleanup.postRevokeNegativeTestsRejected !== true
    ) {
      throw new Error("Paid due-diligence evidence has an unsupported or unreconciled format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadTokenRiskEnrichment(
  evidencePath: string
): Promise<TokenRiskEnrichmentEvidence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as TokenRiskEnrichmentEvidence;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== "token-risk" ||
      parsed.enrichmentKind !== "post-run-index-and-dex-enrichment" ||
      parsed.settlement?.status !== "not-paid" ||
      !parsed.source?.missionId ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.source.reportHash) ||
      !Number.isSafeInteger(parsed.source.blockNumber) ||
      !/^0x[0-9a-fA-F]{40}$/.test(parsed.source.target) ||
      !Number.isFinite(parsed.timing?.durationMs) ||
      parsed.timing.durationMs < 0 ||
      parsed.dex?.version !== 1 ||
      parsed.dex.engine?.method !== "historical-eth-call" ||
      parsed.dex.blockNumber !== parsed.source.blockNumber ||
      parsed.dex.target.toLowerCase() !== parsed.source.target.toLowerCase() ||
      parsed.dex.coverage?.liquidity !== "measured" ||
      (parsed.dex.coverage?.sellability !== "partial" && parsed.dex.coverage?.sellability !== "measured") ||
      !Array.isArray(parsed.dex.v3?.pools) ||
      (parsed.dex.quote?.status !== "quote-only" && parsed.dex.quote?.status !== "unavailable") ||
      (parsed.indexedData?.holderConcentration?.status !== "unavailable" &&
        parsed.indexedData?.holderConcentration?.status !== "measured") ||
      !Array.isArray(parsed.indexedData?.attempts) ||
      !Number.isInteger(parsed.coverage?.originalMeasured) ||
      !Number.isInteger(parsed.coverage?.postRunMeasured) ||
      !Number.isInteger(parsed.coverage?.total) ||
      parsed.coverage.postRunMeasured < parsed.coverage.originalMeasured ||
      parsed.coverage.postRunMeasured > parsed.coverage.total ||
      !Array.isArray(parsed.coverage.added) ||
      !Array.isArray(parsed.coverage.partial) ||
      !Array.isArray(parsed.coverage.unavailable) ||
      !Array.isArray(parsed.limitations)
    ) {
      throw new Error("Token-risk enrichment evidence has an unsupported format");
    }
    if (
      parsed.indexedData.holderConcentration.status === "measured" &&
      (
        !Number.isSafeInteger(parsed.indexedData.holderConcentration.snapshotBlock) ||
        !Number.isSafeInteger(parsed.indexedData.holderConcentration.holderCount) ||
        parsed.indexedData.holderConcentration.holderCount <= 0 ||
        !/^\d+$/.test(parsed.indexedData.holderConcentration.totalSupplyRaw) ||
        parsed.indexedData.holderConcentration.validation?.complete !== true ||
        parsed.indexedData.holderConcentration.validation.balanceReadFailures !== 0 ||
        parsed.indexedData.holderConcentration.validation.missingSupplyRaw !== "0" ||
        parsed.indexedData.holderConcentration.validation.blockBalanceSumRaw !==
          parsed.indexedData.holderConcentration.totalSupplyRaw ||
        parsed.indexedData.holderConcentration.validation.totalSupplyRaw !==
          parsed.indexedData.holderConcentration.totalSupplyRaw
      )
    ) {
      throw new Error("Token-risk holder snapshot is not fully reconciled");
    }
    if (
      parsed.dex.coverage.sellability === "measured" &&
      (
        parsed.sellabilityExecution?.status !== "confirmed" ||
        parsed.sellabilityExecution.routerAllowanceAfterSwapRaw !== "0" ||
        !/^0x[0-9a-fA-F]{64}$/.test(parsed.sellabilityExecution.swapTransaction)
      )
    ) {
      throw new Error("Token-risk executed sellability evidence is incomplete");
    }
    if (
      parsed.indexedData.recentTransactions.status === "measured" &&
      (
        !Number.isInteger(parsed.indexedData.recentTransactions.observedTransfers) ||
        !parsed.indexedData.recentTransactions.activity ||
        parsed.indexedData.recentTransactions.activity.transfers !==
          parsed.indexedData.recentTransactions.observedTransfers
      )
    ) {
      throw new Error("Token-risk enrichment recent activity is internally inconsistent");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadModelOnlyBaselineCandidate(
  evidencePath: string,
  kind: ModelOnlyBaselineCandidate["kind"],
  toolEvidencePath?: string
): Promise<ModelOnlyBaselineCandidate | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as {
      version?: unknown;
      experimentId?: unknown;
      status?: unknown;
      timing?: {
        wallDurationMs?: unknown;
        rpcDurationMs?: unknown;
        modelDurationMs?: unknown;
        totalWallDurationMs?: unknown;
        slitherDurationMs?: unknown;
      };
      model?: { provider?: unknown; model?: unknown };
      usage?: { totalTokens?: unknown };
      cost?: { totalUsd?: unknown };
      report?: {
        vulnerabilities?: unknown[];
        riskSignals?: unknown[];
        recommendation?: unknown;
        trustDecision?: unknown;
      };
      candidateQuality?: {
        truePositives?: unknown;
        falsePositives?: unknown;
        falseNegatives?: unknown;
      };
      candidateSeverityAccuracy?: { accuracy?: unknown };
      postFreezeOperatorReview?: { independentHuman?: unknown; corrections?: unknown[] };
      comparisonEligibility?: { controlledBaseline?: unknown };
      limitations?: unknown;
    };
    const expectedExperimentId = kind === "due-diligence" ? "full-due-diligence" : kind;
    const modelDurationMs = parsed.timing?.modelDurationMs ?? parsed.timing?.wallDurationMs;
    const durationMs = parsed.timing?.totalWallDurationMs ?? modelDurationMs;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== expectedExperimentId ||
      parsed.status !== "non-blind-operator-candidate" ||
      parsed.comparisonEligibility?.controlledBaseline !== false ||
      typeof parsed.model?.provider !== "string" ||
      typeof parsed.model.model !== "string" ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      typeof parsed.usage?.totalTokens !== "number" ||
      !Number.isSafeInteger(parsed.usage.totalTokens) ||
      parsed.usage.totalTokens <= 0 ||
      parsed.cost?.totalUsd !== null ||
      !Array.isArray(parsed.limitations)
    ) {
      throw new Error(`${kind} model-only baseline candidate has an unsupported format`);
    }
    const common: ModelOnlyCandidateCommon = {
      status: "model-only-candidate",
      experimentId: expectedExperimentId,
      model: { provider: parsed.model.provider, model: parsed.model.model },
      durationMs,
      totalTokens: parsed.usage.totalTokens,
      controlledBaseline: false,
      independentHuman: false,
      costUsd: null,
      limitations: parsed.limitations.filter((item): item is string => typeof item === "string")
    };
    if (kind === "contract-audit") {
      if (
        !Array.isArray(parsed.report?.vulnerabilities) ||
        typeof parsed.candidateQuality?.truePositives !== "number" ||
        typeof parsed.candidateQuality.falsePositives !== "number" ||
        typeof parsed.candidateQuality.falseNegatives !== "number" ||
        typeof parsed.candidateSeverityAccuracy?.accuracy !== "number"
      ) {
        throw new Error("Contract-audit model-only candidate metrics are incomplete");
      }
      return {
        ...common,
        kind,
        experimentId: "contract-audit",
        outcome: {
          findings: parsed.report.vulnerabilities.length,
          truePositives: parsed.candidateQuality.truePositives,
          falsePositives: parsed.candidateQuality.falsePositives,
          falseNegatives: parsed.candidateQuality.falseNegatives,
          severityAccuracy: parsed.candidateSeverityAccuracy.accuracy
        }
      };
    }
    if (kind === "token-risk") {
      if (
        typeof parsed.timing?.rpcDurationMs !== "number" ||
        typeof modelDurationMs !== "number" ||
        !Array.isArray(parsed.report?.riskSignals) ||
        typeof parsed.report.recommendation !== "string"
      ) {
        throw new Error("Token-risk model-only candidate metrics are incomplete");
      }
      return {
        ...common,
        kind,
        experimentId: "token-risk",
        outcome: {
          rpcDurationMs: parsed.timing.rpcDurationMs,
          modelDurationMs,
          riskSignals: parsed.report.riskSignals.length,
          recommendation: parsed.report.recommendation
        }
      };
    }
    if (
      typeof parsed.timing?.slitherDurationMs !== "number" ||
      typeof parsed.report?.trustDecision !== "string" ||
      parsed.postFreezeOperatorReview?.independentHuman !== false ||
      !Array.isArray(parsed.postFreezeOperatorReview.corrections) ||
      !toolEvidencePath
    ) {
      throw new Error("Due-diligence model-only candidate metrics are incomplete");
    }
    const toolEvidence = JSON.parse(await readFile(toolEvidencePath, "utf8")) as {
      status?: unknown;
      ok?: unknown;
      detections?: unknown;
    };
    if (toolEvidence.status !== "measured" || toolEvidence.ok !== true || !Array.isArray(toolEvidence.detections)) {
      throw new Error("Due-diligence model-only candidate Slither evidence is unavailable");
    }
    return {
      ...common,
      kind,
      experimentId: "full-due-diligence",
      outcome: {
        slitherDurationMs: parsed.timing.slitherDurationMs,
        rawSlitherDetections: toolEvidence.detections.length,
        trustDecision: parsed.report.trustDecision,
        postFreezeCorrections: parsed.postFreezeOperatorReview.corrections.length
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadAdvantageComparisonBundle(
  evidencePath: string
): Promise<AdvantageComparisonBundle | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as AdvantageComparisonBundle;
    const expectedExperiments = new Set([
      "contract-audit",
      "token-risk",
      "full-due-diligence"
    ]);
    const experimentIds = new Set(parsed.experiments?.map((item) => item.experimentId));
    if (
      parsed.version !== 1 ||
      parsed.artifactKind !== "termix-agent-advantage-report" ||
      parsed.status !== "complete-for-official-termix" ||
      parsed.officialRequirement?.requiresHumanReviewer !== false ||
      parsed.disclosure?.independentHumanReviewPerformed !== false ||
      !Array.isArray(parsed.experiments) ||
      parsed.experiments.length !== expectedExperiments.size ||
      [...expectedExperiments].some((id) => !experimentIds.has(id as never)) ||
      parsed.experiments.some((item) =>
        item.baseline?.status !== "measured" ||
        item.baseline.workflow !== "without-marketplace-agent" ||
        item.baseline.independentHuman !== false ||
        !item.baseline.model?.provider ||
        !item.baseline.model.model ||
        !Number.isFinite(item.baseline.durationMs) ||
        item.baseline.durationMs <= 0 ||
        !Number.isSafeInteger(item.baseline.totalTokens) ||
        item.baseline.totalTokens <= 0 ||
        !Number.isFinite(item.baseline.costUsd) ||
        item.baseline.costUsd < 0 ||
        !Number.isFinite(item.baseline.qualityScore) ||
        item.baseline.qualityScore < 0 ||
        item.baseline.qualityScore > 100 ||
        item.baseline.qualityScale !== 100 ||
        !/^sha256:[0-9a-f]{64}$/.test(item.baseline.artifactHash) ||
        item.agent?.qualityScale !== 100 ||
        !Number.isFinite(item.agent.qualityScore) ||
        item.agent.qualityScore < 0 ||
        item.agent.qualityScore > 100 ||
        !Array.isArray(item.agent.evidence) ||
        item.comparison?.status !== "completed" ||
        !Number.isFinite(item.comparison.qualityDelta) ||
        !Number.isFinite(item.comparison.durationDeltaMs) ||
        item.groundTruth?.status !== "reviewed" ||
        item.groundTruth.independentHuman !== false ||
        !item.groundTruth.benchmarkId ||
        !/^sha256:[0-9a-f]{64}$/.test(item.groundTruth.sourceHash) ||
        !Number.isSafeInteger(item.groundTruth.findings) ||
        item.groundTruth.findings <= 0 ||
        !Array.isArray(item.groundTruth.reviewMethod) ||
        !/^sha256:[0-9a-f]{64}$/.test(item.groundTruth.artifactHash)
      )
    ) {
      throw new Error("Agent Advantage comparison bundle has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
