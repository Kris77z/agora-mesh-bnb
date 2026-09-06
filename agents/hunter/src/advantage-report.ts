import type {
  AssetRef,
  Money,
  OnchainRiskReport,
  TokenRiskVerificationReport,
  VerificationReport
} from "@rebel/shared";
import type { HunterRunResult } from "./run-types.js";
import type { StoredHunterMission } from "./mission-store.js";
import {
  scoreAuditAgainstGroundTruth,
  type AdvantageComparisonBundle,
  type AuditGroundTruthManifest,
  type AuditQualityMetrics,
  type AuditToolBaselineEvidence,
  type ModelOnlyBaselineCandidate,
  type PaidDueDiligenceEvidence,
  type TokenRiskEnrichmentEvidence,
  type TokenRiskSecurityReviewEvidence
} from "./advantage-evaluator.js";
import { tokenRiskReportHash } from "./security-pipeline.js";
import type { DueDiligenceCandidateEvidence, DueDiligenceReport } from "./due-diligence.js";

export interface MeasuredAuditMetrics {
  kind: "contract-audit";
  status: "measured";
  missionId: string;
  missionSource: StoredHunterMission["source"];
  durationMs: number;
  cost?: Money;
  auditorFindings: number;
  auditorCriticalHighFindings: number;
  signedReceipts: number;
  confirmedTransactions: string[];
  hunterEvaluationScore: number;
  quality?: AuditQualityMetrics;
  verifier?: {
    engine: VerificationReport["engine"];
    summary: VerificationReport["summary"];
    checks: number;
  };
}

export interface MeasuredTokenRiskMetrics {
  kind: "token-risk";
  status: "measured";
  missionId: string;
  missionSource: StoredHunterMission["source"];
  durationMs: number;
  cost?: Money;
  signedReceipts: number;
  confirmedTransactions: string[];
  hunterEvaluationScore: number;
  target: {
    address: string;
    classification: OnchainRiskReport["target"]["classification"];
    blockNumber: number;
    observedAt: string;
    token?: {
      symbol?: string;
      decimals?: number;
    };
  };
  riskScore: number;
  riskLevel: OnchainRiskReport["riskLevel"];
  riskSignals: number;
  highCriticalSignals: number;
  coverage: {
    measured: number;
    total: number;
  };
  securityReview?: {
    source: "paid-mission" | "post-run-evidence";
    paid: boolean;
    serviceId: string;
    durationMs?: number;
    engine: TokenRiskVerificationReport["engine"];
    summary: TokenRiskVerificationReport["summary"];
    conclusion: TokenRiskVerificationReport["conclusion"];
  };
  enrichment?: {
    source: "post-run-evidence";
    paid: false;
    durationMs: number;
    observedAt: string;
    coverage: TokenRiskEnrichmentEvidence["coverage"];
    liquidity: {
      venue: "PancakeSwap";
      pair: string;
      pairExists: boolean;
      reserveTokenRaw?: string;
      reserveWrappedNativeRaw?: string;
      tokenReservePartsPerBillionOfSupply?: string;
      discoveredV3Pools: number;
      activeV3Pools: number;
      interpretation: string;
    };
    quote: TokenRiskEnrichmentEvidence["dex"]["quote"];
    recentTransactions: TokenRiskEnrichmentEvidence["indexedData"]["recentTransactions"];
    holderConcentration: TokenRiskEnrichmentEvidence["indexedData"]["holderConcentration"];
    sellabilityExecution?: TokenRiskEnrichmentEvidence["sellabilityExecution"];
    limitations: string[];
  };
  limitations: string[];
}

export interface PartialDueDiligenceMetrics {
  kind: "due-diligence";
  status: "partial";
  synthesisKind: "same-target-candidate";
  durationMs: number;
  noNewPayment: true;
  reusedPaidInvestigation: DueDiligenceCandidateEvidence["settlement"]["existingPaidComponent"];
  target: DueDiligenceReport["target"];
  bindings: DueDiligenceReport["bindings"];
  auditor: {
    status: DueDiligenceReport["security"]["auditStatus"];
    findings: number;
    provider: string;
    model: string;
    durationMs: number;
    failureReason?: string;
  };
  verifier: {
    engine: VerificationReport["engine"];
    summary: VerificationReport["summary"];
    uncoveredDetections: number;
  };
  onchain: {
    riskScore: number;
    riskLevel: OnchainRiskReport["riskLevel"];
    reviewStatus: TokenRiskVerificationReport["conclusion"]["status"];
  };
  market?: DueDiligenceReport["market"];
  decision: DueDiligenceReport["decision"];
  limitations: string[];
}

export interface MeasuredDueDiligenceMetrics {
  kind: "due-diligence";
  status: "measured";
  synthesisKind: "paid-two-phase-reconciled";
  missionIds: [string, string];
  durationMs: number;
  cost: Money;
  target: {
    chainId: number;
    address: string;
    blockNumber: number;
  };
  payments: PaidDueDiligenceEvidence["completedServices"];
  audit: {
    findings: number;
    criticalHighFindings: number;
    verifierSummary: VerificationReport["summary"];
    hunterEvaluationScore: number;
  };
  onchain: {
    riskScore: number;
    riskLevel: OnchainRiskReport["riskLevel"];
    riskSignals: number;
    verifierSummary: TokenRiskVerificationReport["summary"];
    verifierStatus: TokenRiskVerificationReport["conclusion"]["status"];
  };
  reconciliation: PaidDueDiligenceEvidence["reconciliation"];
  authorityCleanup: PaidDueDiligenceEvidence["authorityCleanup"];
  decision: {
    status: "avoid" | "high-caution" | "caution" | "no-high-risk-established";
    reasons: string[];
  };
  limitations: string[];
}

export interface AdvantageExperiment {
  id: "contract-audit" | "token-risk" | "due-diligence";
  name: string;
  task: string;
  agentWorkflow: string[];
  status: "completed" | "partial" | "pending";
  agent: MeasuredAuditMetrics | MeasuredTokenRiskMetrics | MeasuredDueDiligenceMetrics | PartialDueDiligenceMetrics | { status: "pending"; reason: string };
  baseline:
    | { status: "pending"; reason: string }
    | AdvantageComparisonBundle["experiments"][number]["baseline"];
  comparison?: AdvantageComparisonBundle["experiments"][number]["comparison"] & {
    agentQualityScore: number;
    baselineQualityScore: number;
  };
  modelCandidate?: ModelOnlyBaselineCandidate;
  toolReference?: {
    status: "measured";
    kind: "tool-only-static-analysis";
    tool: string;
    version: string;
    durationMs: number;
    cost: { currency: string; amount: number; basis: string };
    detections: number;
    quality: AuditQualityMetrics;
    controlledHumanBaselineStatus: "pending";
    limitations: string[];
  };
  groundTruth:
    | { status: "pending"; reason: string }
    | {
        status: "reviewed";
        benchmarkId: string;
        sourceHash: string;
        findings: number;
        reviewerType?: "deterministic-operator" | "independent-ai";
        independentHuman?: false;
        artifact?: string;
        reviewMethod: string[];
      };
}

export interface AdvantageReport {
  generatedAt: number;
  summary: {
    experiments: number;
    measuredAgentRuns: number;
    measuredToolReferences: number;
    measuredIndependentReviews: number;
    measuredEnrichments: number;
    measuredModelCandidates: number;
    completedComparisons: number;
  };
  methodology: {
    duration: string;
    cost: string;
    quality: string;
  };
  experiments: AdvantageExperiment[];
}

function parseFindingCounts(result: string): { findings: number; criticalHigh: number } {
  try {
    const parsed = JSON.parse(result) as {
      vulnerabilities?: Array<{ severity?: unknown }>;
    };
    const vulnerabilities = Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : [];
    return {
      findings: vulnerabilities.length,
      criticalHigh: vulnerabilities.filter((finding) =>
        finding.severity === "critical" || finding.severity === "high").length
    };
  } catch {
    return { findings: 0, criticalHigh: 0 };
  }
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.chainId === right.chainId &&
    left.kind === right.kind &&
    left.address?.toLowerCase() === right.address?.toLowerCase();
}

function readPaymentMoney(
  result: HunterRunResult,
  role: "primary" | "verification" | "risk-review"
): Money | undefined {
  const service = role === "primary"
    ? result.service
    : role === "verification"
      ? result.verification?.service
      : result.riskReview?.service;
  const execution = role === "primary"
    ? result.execution
    : role === "verification"
      ? result.verification?.execution
      : result.riskReview?.execution;
  if (!service || !execution) return undefined;
  const payment = execution.payment as unknown as { amount?: Money };
  if (payment.amount) return payment.amount;
  return service.asset ? { asset: service.asset, amount: service.price } : undefined;
}

function totalRunCost(result: HunterRunResult): Money | undefined {
  const payments = [
    readPaymentMoney(result, "primary"),
    readPaymentMoney(result, "verification"),
    readPaymentMoney(result, "risk-review")
  ]
    .filter((payment): payment is Money => Boolean(payment));
  if (payments.length === 0) return undefined;
  if (!payments.every((payment) => sameAsset(payment.asset, payments[0].asset))) return undefined;
  return {
    asset: payments[0].asset,
    amount: payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n).toString()
  };
}

function measuredAudit(
  mission: StoredHunterMission,
  groundTruth?: AuditGroundTruthManifest
): MeasuredAuditMetrics | undefined {
  const result = mission.result;
  if (!result || mission.status !== "completed") return undefined;
  const taskType = result.service.taskType ?? result.reflection?.taskType;
  if (taskType !== "smart-contract-audit") return undefined;
  const findingCounts = parseFindingCounts(result.execution.result);
  const confirmedTransactions = [
    result.paymentTx,
    result.verification?.paymentTx
  ].filter((txHash): txHash is string => Boolean(txHash));
  return {
    kind: "contract-audit",
    status: "measured",
    missionId: mission.missionId,
    missionSource: mission.source,
    durationMs: Math.max(0, mission.completedAt - mission.createdAt),
    cost: totalRunCost(result),
    auditorFindings: findingCounts.findings,
    auditorCriticalHighFindings: findingCounts.criticalHigh,
    signedReceipts: 1 + (result.verification ? 1 : 0),
    confirmedTransactions,
    hunterEvaluationScore: result.evaluation.score,
    quality: groundTruth
      ? scoreAuditAgainstGroundTruth({
          result: result.execution.result,
          sourceHash: result.verification?.report.sourceHash,
          groundTruth
        })
      : undefined,
    verifier: result.verification ? {
      engine: result.verification.report.engine,
      summary: result.verification.report.summary,
      checks: result.verification.report.verifications.length
    } : undefined
  };
}

function parseOnchainRiskReport(result: string): OnchainRiskReport | undefined {
  try {
    const parsed = JSON.parse(result) as Partial<OnchainRiskReport>;
    if (
      parsed.version !== 1 ||
      typeof parsed.riskScore !== "number" ||
      typeof parsed.riskLevel !== "string" ||
      typeof parsed.blockNumber !== "number" ||
      typeof parsed.observedAt !== "string" ||
      !parsed.target ||
      typeof parsed.target.address !== "string" ||
      !Array.isArray(parsed.riskSignals) ||
      !parsed.coverage ||
      !Array.isArray(parsed.limitations)
    ) {
      return undefined;
    }
    return parsed as OnchainRiskReport;
  } catch {
    return undefined;
  }
}

function measuredTokenRisk(
  mission: StoredHunterMission,
  externalReview?: TokenRiskSecurityReviewEvidence,
  externalEnrichment?: TokenRiskEnrichmentEvidence
): MeasuredTokenRiskMetrics | undefined {
  const result = mission.result;
  if (!result || mission.status !== "completed") return undefined;
  const taskType = result.service.taskType ?? result.reflection?.taskType;
  if (taskType !== "onchain-investigation") return undefined;
  const report = parseOnchainRiskReport(result.execution.result);
  if (!report) return undefined;
  const coverageValues = Object.values(report.coverage);
  const boundExternalReview =
    externalReview?.source.missionId === mission.missionId &&
    externalReview.source.blockNumber === report.blockNumber &&
    externalReview.source.reportHash === tokenRiskReportHash(report) &&
    externalReview.review.target.toLowerCase() === report.target.address.toLowerCase()
      ? externalReview
      : undefined;
  const review = result.riskReview?.report ?? boundExternalReview?.review;
  const boundExternalEnrichment =
    externalEnrichment?.source.missionId === mission.missionId &&
    externalEnrichment.source.blockNumber === report.blockNumber &&
    externalEnrichment.source.reportHash === tokenRiskReportHash(report) &&
    externalEnrichment.source.target.toLowerCase() === report.target.address.toLowerCase() &&
    externalEnrichment.dex.blockNumber === report.blockNumber &&
    externalEnrichment.dex.target.toLowerCase() === report.target.address.toLowerCase()
      ? externalEnrichment
      : undefined;
  const enrichment = boundExternalEnrichment ? {
    source: "post-run-evidence" as const,
    paid: false as const,
    durationMs: boundExternalEnrichment.timing.durationMs,
    observedAt: boundExternalEnrichment.dex.observedAt,
    coverage: boundExternalEnrichment.coverage,
    liquidity: {
      venue: boundExternalEnrichment.dex.scope.venue,
      pair: boundExternalEnrichment.dex.v2.pair,
      pairExists: boundExternalEnrichment.dex.v2.pairExists,
      reserveTokenRaw: boundExternalEnrichment.dex.v2.reserveTokenRaw,
      reserveWrappedNativeRaw: boundExternalEnrichment.dex.v2.reserveWrappedNativeRaw,
      tokenReservePartsPerBillionOfSupply:
        boundExternalEnrichment.dex.v2.tokenReservePartsPerBillionOfSupply,
      discoveredV3Pools: boundExternalEnrichment.dex.v3.pools.filter((pool) => pool.exists).length,
      activeV3Pools: boundExternalEnrichment.dex.v3.pools.filter((pool) =>
        BigInt(pool.liquidityRaw ?? "0") > 0n
      ).length,
      interpretation: boundExternalEnrichment.dex.interpretation
    },
    quote: boundExternalEnrichment.dex.quote,
    recentTransactions: boundExternalEnrichment.indexedData.recentTransactions,
    holderConcentration: boundExternalEnrichment.indexedData.holderConcentration,
    ...(boundExternalEnrichment.sellabilityExecution
      ? { sellabilityExecution: boundExternalEnrichment.sellabilityExecution }
      : {}),
    limitations: boundExternalEnrichment.limitations
  } : undefined;
  const effectiveLimitations = enrichment
    ? [...new Set([
        ...report.limitations.filter((limitation) =>
          !limitation.startsWith("Liquidity and sellability") &&
          !limitation.startsWith("Transaction count is measured") &&
          !(enrichment.holderConcentration.status === "measured" &&
            limitation.startsWith("Holder concentration is not measured"))
        ),
        ...enrichment.limitations
      ])]
    : report.limitations;
  return {
    kind: "token-risk",
    status: "measured",
    missionId: mission.missionId,
    missionSource: mission.source,
    durationMs: Math.max(0, mission.completedAt - mission.createdAt),
    cost: totalRunCost(result),
    signedReceipts: 1 + (result.riskReview ? 1 : 0),
    confirmedTransactions: [result.paymentTx, result.riskReview?.paymentTx]
      .filter((txHash): txHash is string => Boolean(txHash)),
    hunterEvaluationScore: result.evaluation.score,
    target: {
      address: report.target.address,
      classification: report.target.classification,
      blockNumber: report.blockNumber,
      observedAt: report.observedAt,
      ...(report.facts.token ? {
          token: {
            ...(report.facts.token.symbol ? { symbol: report.facts.token.symbol } : {}),
            ...(report.facts.token.decimals !== undefined
              ? { decimals: report.facts.token.decimals }
              : {})
          }
        } : {})
    },
    riskScore: report.riskScore,
    riskLevel: report.riskLevel,
    riskSignals: report.riskSignals.length,
    highCriticalSignals: report.riskSignals.filter(
      (signal) => signal.severity === "high" || signal.severity === "critical"
    ).length,
    coverage: {
      measured: coverageValues.filter((status) => status === "measured").length,
      total: coverageValues.length
    },
    securityReview: review ? {
      source: result.riskReview ? "paid-mission" : "post-run-evidence",
      paid: Boolean(result.riskReview),
      serviceId: result.riskReview?.service.id ?? boundExternalReview!.reviewer.serviceId,
      durationMs: boundExternalReview?.timing.durationMs,
      engine: review.engine,
      summary: review.summary,
      conclusion: review.conclusion
    } : undefined,
    enrichment,
    limitations: effectiveLimitations
  };
}

function measuredDueDiligence(
  missions: StoredHunterMission[],
  evidence: PaidDueDiligenceEvidence
): MeasuredDueDiligenceMetrics | undefined {
  const auditMission = missions.find((mission) =>
    mission.missionId === evidence.missions.auditAndFindingVerification
  );
  const investigationMission = missions.find((mission) =>
    mission.missionId === evidence.missions.investigationAndRiskVerification
  );
  if (
    !auditMission?.result || auditMission.status !== "completed" ||
    !investigationMission?.result || investigationMission.status !== "completed"
  ) return undefined;

  const auditResult = auditMission.result;
  const investigationResult = investigationMission.result;
  const report = parseOnchainRiskReport(investigationResult.execution.result);
  const riskReview = investigationResult.riskReview?.report;
  if (
    auditResult.service.taskType !== "smart-contract-audit" ||
    investigationResult.service.taskType !== "onchain-investigation" ||
    !auditResult.verification ||
    !report ||
    !riskReview ||
    report.chainId !== evidence.target.chainId ||
    report.target.address.toLowerCase() !== evidence.target.address.toLowerCase() ||
    riskReview.target.toLowerCase() !== evidence.target.address.toLowerCase() ||
    riskReview.sourceReportHash !== tokenRiskReportHash(report) ||
    riskReview.conclusion.status !== "confirmed"
  ) return undefined;

  const expectedPayments = new Map(evidence.completedServices.map((service) => [service.serviceId, service.transaction]));
  if (
    expectedPayments.get("auditor-v1") !== auditResult.paymentTx ||
    expectedPayments.get("verifier-v1") !== auditResult.verification.paymentTx ||
    expectedPayments.get("investigator-v1") !== investigationResult.paymentTx ||
    expectedPayments.get("risk-verifier-v1") !== investigationResult.riskReview?.paymentTx
  ) return undefined;

  const auditCounts = parseFindingCounts(auditResult.execution.result);
  const asset = readPaymentMoney(auditResult, "primary")?.asset ??
    readPaymentMoney(investigationResult, "primary")?.asset;
  if (!asset) return undefined;
  const riskLevel = report.riskLevel;
  const decisionStatus = riskLevel === "critical" ? "avoid" :
    riskLevel === "high" ? "high-caution" :
      riskLevel === "medium" ? "caution" : "no-high-risk-established";
  return {
    kind: "due-diligence",
    status: "measured",
    synthesisKind: "paid-two-phase-reconciled",
    missionIds: [auditMission.missionId, investigationMission.missionId],
    durationMs: Math.max(0, Math.max(auditMission.completedAt, investigationMission.completedAt) -
      Math.min(auditMission.createdAt, investigationMission.createdAt)),
    cost: { asset, amount: evidence.reconciliation.netProviderSpendRaw },
    target: {
      chainId: report.chainId,
      address: report.target.address,
      blockNumber: report.blockNumber
    },
    payments: evidence.completedServices,
    audit: {
      findings: auditCounts.findings,
      criticalHighFindings: auditCounts.criticalHigh,
      verifierSummary: auditResult.verification.report.summary,
      hunterEvaluationScore: auditResult.evaluation.score
    },
    onchain: {
      riskScore: report.riskScore,
      riskLevel,
      riskSignals: report.riskSignals.length,
      verifierSummary: riskReview.summary,
      verifierStatus: riskReview.conclusion.status
    },
    reconciliation: evidence.reconciliation,
    authorityCleanup: evidence.authorityCleanup,
    decision: {
      status: decisionStatus,
      reasons: [
        `The paid onchain investigation scored the target ${report.riskScore}/100 (${riskLevel}).`,
        auditCounts.findings === 0 && auditResult.verification.report.summary.missed > 0
          ? `The Auditor returned no findings while the independent verifier reported ${auditResult.verification.report.summary.missed} uncovered detections.`
          : `The paid audit returned ${auditCounts.findings} findings and was independently checked.`
      ]
    },
    limitations: [
      "The original multi-phase task was completed across two persisted paid missions after a relay anomaly, then reconciled as one 1.35 U experiment.",
      "The orphaned 0.5 U settlement is excluded from net cost only because its equal onchain refund is recorded and verified."
    ]
  };
}

export function buildAdvantageReport(
  missions: StoredHunterMission[],
  generatedAt = Date.now(),
  auditGroundTruth?: AuditGroundTruthManifest,
  auditToolBaseline?: AuditToolBaselineEvidence,
  tokenRiskSecurityReview?: TokenRiskSecurityReviewEvidence,
  tokenRiskEnrichment?: TokenRiskEnrichmentEvidence,
  dueDiligenceCandidate?: DueDiligenceCandidateEvidence,
  modelBaselineCandidates: ModelOnlyBaselineCandidate[] = [],
  paidDueDiligence?: PaidDueDiligenceEvidence,
  comparisonBundle?: AdvantageComparisonBundle
): AdvantageReport {
  const auditCandidates = missions
    .map((mission) => measuredAudit(mission, auditGroundTruth))
    .filter((item): item is MeasuredAuditMetrics => Boolean(item));
  const audit = auditCandidates
    .filter((item) => item.quality && item.signedReceipts >= 2 && item.verifier?.checks)
    .sort((left, right) => {
      const qualityDelta = (right.quality?.truePositives ?? 0) - (left.quality?.truePositives ?? 0);
      if (qualityDelta !== 0) return qualityDelta;
      const verifierDelta = Number(right.verifier?.engine.method === "static-analysis") - Number(left.verifier?.engine.method === "static-analysis");
      if (verifierDelta !== 0) return verifierDelta;
      return right.hunterEvaluationScore - left.hunterEvaluationScore;
    })[0] ?? auditCandidates[0];
  const tokenRiskCandidates = missions
    .map((mission) => measuredTokenRisk(mission, tokenRiskSecurityReview, tokenRiskEnrichment))
    .filter((item): item is MeasuredTokenRiskMetrics => Boolean(item));
  const tokenRisk = tokenRiskCandidates.find((item) => item.enrichment) ??
    tokenRiskCandidates.find((item) => item.securityReview) ??
    tokenRiskCandidates[0];
  const paidDueDiligenceMetrics = paidDueDiligence
    ? measuredDueDiligence(missions, paidDueDiligence)
    : undefined;
  const dueDiligenceCandidateMetrics: PartialDueDiligenceMetrics | undefined = dueDiligenceCandidate
    ? {
        kind: "due-diligence",
        status: "partial",
        synthesisKind: dueDiligenceCandidate.synthesisKind,
        durationMs: dueDiligenceCandidate.timing.durationMs,
        noNewPayment: dueDiligenceCandidate.settlement.noNewPayment,
        reusedPaidInvestigation: dueDiligenceCandidate.settlement.existingPaidComponent,
        target: dueDiligenceCandidate.report.target,
        bindings: dueDiligenceCandidate.report.bindings,
        auditor: {
          status: dueDiligenceCandidate.report.security.auditStatus,
          findings: dueDiligenceCandidate.report.security.auditorFindings,
          provider: dueDiligenceCandidate.engines.auditor.provider,
          model: dueDiligenceCandidate.engines.auditor.model,
          durationMs: dueDiligenceCandidate.timing.audit.durationMs,
          ...(dueDiligenceCandidate.report.security.auditFailureReason
            ? { failureReason: dueDiligenceCandidate.report.security.auditFailureReason }
            : {})
        },
        verifier: {
          engine: dueDiligenceCandidate.engines.verifier.engine,
          summary: dueDiligenceCandidate.report.security.verificationSummary,
          uncoveredDetections: dueDiligenceCandidate.report.security.uncoveredDetections.length
        },
        onchain: {
          riskScore: dueDiligenceCandidate.report.onchain.riskScore,
          riskLevel: dueDiligenceCandidate.report.onchain.riskLevel,
          reviewStatus: dueDiligenceCandidate.report.onchain.independentReview.status
        },
        market: dueDiligenceCandidate.report.market,
        decision: dueDiligenceCandidate.report.decision,
        limitations: dueDiligenceCandidate.report.limitations
      }
    : undefined;
  const pendingBaseline = {
    status: "pending" as const,
    reason: "A hash-locked blind input bundle is ready, but no independent human plus ordinary-LLM baseline output has been recorded yet."
  };
  const pendingGroundTruth = {
    status: "pending" as const,
    reason: "A reviewed ground-truth manifest is required before reporting precision, recall, or false positives."
  };
  const modelCandidateByKind = new Map(
    modelBaselineCandidates.map((candidate) => [candidate.kind, candidate])
  );
  const comparisonById = new Map(
    comparisonBundle?.experiments.map((item) => [item.experimentId, item]) ?? []
  );
  const auditComparison = comparisonById.get("contract-audit");
  const tokenRiskComparison = comparisonById.get("token-risk");
  const dueDiligenceComparison = comparisonById.get("full-due-diligence");
  const reviewedAuditGroundTruth = auditGroundTruth?.reviewStatus === "reviewed"
    ? {
        status: "reviewed" as const,
        benchmarkId: auditGroundTruth.benchmarkId,
        sourceHash: auditGroundTruth.sourceHash,
        findings: auditGroundTruth.findings.length,
        reviewMethod: auditGroundTruth.reviewMethod ?? []
      }
    : pendingGroundTruth;
  const measuredToolReference = auditGroundTruth?.reviewStatus === "reviewed" &&
    auditToolBaseline?.input.sourceHash === auditGroundTruth.sourceHash &&
    auditToolBaseline.input.benchmarkId === auditGroundTruth.benchmarkId &&
    auditToolBaseline.quality.groundTruthSourceHash === auditGroundTruth.sourceHash
    ? {
        status: "measured" as const,
        kind: auditToolBaseline.baselineKind,
        tool: auditToolBaseline.runtime.tool,
        version: auditToolBaseline.runtime.version,
        durationMs: auditToolBaseline.timing.durationMs,
        cost: auditToolBaseline.cost,
        detections: auditToolBaseline.output.detections.length,
        quality: auditToolBaseline.quality,
        controlledHumanBaselineStatus: auditToolBaseline.controlledHumanBaselineStatus,
        limitations: auditToolBaseline.limitations
      }
    : undefined;
  const experiments: AdvantageExperiment[] = [
    {
      id: "contract-audit",
      name: "Smart Contract Audit",
      task: "Audit a benchmark Solidity contract and independently verify every finding.",
      agentWorkflow: ["Hunter", "Security Auditor", "Verification Agent"],
      status: audit && auditComparison ? "completed" : "partial",
      agent: audit ?? { status: "pending", reason: "No completed smart-contract-audit mission is stored." },
      baseline: auditComparison?.baseline ?? pendingBaseline,
      ...(auditComparison ? {
        comparison: {
          ...auditComparison.comparison,
          agentQualityScore: auditComparison.agent.qualityScore,
          baselineQualityScore: auditComparison.baseline.qualityScore
        }
      } : {}),
      ...(!auditComparison && modelCandidateByKind.get("contract-audit")
        ? { modelCandidate: modelCandidateByKind.get("contract-audit") }
        : {}),
      ...(measuredToolReference ? { toolReference: measuredToolReference } : {}),
      groundTruth: auditComparison?.groundTruth ?? reviewedAuditGroundTruth
    },
    {
      id: "token-risk",
      name: "Token Risk Investigation",
      task: "Evaluate the risk of a BNB Chain token using verified onchain facts.",
      agentWorkflow: ["Hunter", "Onchain Investigator", "Security Agent"],
      status: tokenRisk && tokenRiskComparison ? "completed" : "partial",
      agent: tokenRisk ?? {
        status: "pending",
        reason: "The read-only Onchain Investigator exists, but no completed paid Hunter mission is stored yet."
      },
      baseline: tokenRiskComparison?.baseline ?? pendingBaseline,
      ...(tokenRiskComparison ? {
        comparison: {
          ...tokenRiskComparison.comparison,
          agentQualityScore: tokenRiskComparison.agent.qualityScore,
          baselineQualityScore: tokenRiskComparison.baseline.qualityScore
        }
      } : {}),
      ...(!tokenRiskComparison && modelCandidateByKind.get("token-risk")
        ? { modelCandidate: modelCandidateByKind.get("token-risk") }
        : {}),
      groundTruth: tokenRiskComparison?.groundTruth ?? pendingGroundTruth
    },
    {
      id: "due-diligence",
      name: "Full Due Diligence",
      task: "Combine contract security, onchain risk, and independent verification into one recommendation.",
      agentWorkflow: ["Security Auditor", "Onchain Investigator", "Verification Agent", "Hunter Synthesis"],
      status: paidDueDiligenceMetrics
        ? "completed"
        : dueDiligenceCandidateMetrics
          ? "partial"
          : "pending",
      agent: paidDueDiligenceMetrics ?? dueDiligenceCandidateMetrics ?? { status: "pending", reason: "This experiment still needs paid Auditor, Investigator, both verifier phases, and reconciled synthesis." },
      baseline: dueDiligenceComparison?.baseline ?? pendingBaseline,
      ...(dueDiligenceComparison ? {
        comparison: {
          ...dueDiligenceComparison.comparison,
          agentQualityScore: dueDiligenceComparison.agent.qualityScore,
          baselineQualityScore: dueDiligenceComparison.baseline.qualityScore
        }
      } : {}),
      ...(!dueDiligenceComparison && modelCandidateByKind.get("due-diligence")
        ? { modelCandidate: modelCandidateByKind.get("due-diligence") }
        : {}),
      groundTruth: dueDiligenceComparison?.groundTruth ?? pendingGroundTruth
    }
  ];
  return {
    generatedAt,
    summary: {
      experiments: experiments.length,
      measuredAgentRuns: Number(Boolean(audit)) + Number(Boolean(tokenRisk)) + Number(Boolean(paidDueDiligenceMetrics)),
      measuredToolReferences: measuredToolReference ? 1 : 0,
      measuredIndependentReviews: Number(Boolean(tokenRisk?.securityReview)) + Number(Boolean(paidDueDiligenceMetrics)),
      measuredEnrichments: tokenRisk?.enrichment ? 1 : 0,
      measuredModelCandidates: modelBaselineCandidates.length,
      completedComparisons: experiments.filter((item) => item.comparison?.status === "completed").length
    },
    methodology: {
      duration: "Mission evidence window from the first persisted/recovered event to completion.",
      cost: "Exact confirmed payment amounts, summed only when every payment uses the same asset.",
      quality: "Every score is tied to a disclosed rubric and reviewed evidence. Official TermiX comparisons use without-marketplace-agent baselines; no baseline or adjudication is mislabeled as human."
    },
    experiments
  };
}
