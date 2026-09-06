import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AuditReport,
  OnchainRiskReport,
  SecurityFinding,
  SecurityTaskInput,
  TokenRiskVerificationReport,
  VerificationReport
} from "@rebel/shared";
import type { TokenRiskEnrichmentEvidence } from "./advantage-evaluator.js";
import { tokenRiskReportHash } from "./security-pipeline.js";

export interface DueDiligenceProvenance {
  audit: "local-unpaid" | "local-unpaid-scoped" | "paid-mission" | "unavailable-timeout";
  findingVerification: "local-unpaid" | "paid-mission";
  onchainInvestigation: "paid-mission";
  tokenRiskReview: "local-unpaid" | "paid-mission";
  enrichment?: "local-unpaid";
}

export interface DueDiligenceReport {
  version: 1;
  experimentId: "full-due-diligence";
  status: "partial";
  generatedAt: string;
  target: {
    chainId: number;
    proxy: string;
    implementation: string;
    sourceName: string;
    sourceHash: string;
    sourceMode: "verified-source";
    reportBlock: number;
  };
  bindings: {
    sourceHashVerified: true;
    sourceAddressMatchesImplementation: true;
    findingVerificationMatchesSource: true;
    tokenReviewMatchesInvestigation: true;
    enrichmentMatchesInvestigation?: true;
  };
  provenance: DueDiligenceProvenance;
  security: {
    auditStatus: "measured" | "measured-partial" | "unavailable";
    auditFailureReason?: string;
    auditScope?: {
      kind: "verified-first-party-source-units";
      packageSourceHash: string;
      scopeSourceHash: string;
      includedSourceUnits: string[];
      omittedDependencySourceUnits: string[];
      sourceBytes: number;
      limitation: string;
    };
    auditorFindings: number;
    criticalHighFindings: number;
    verificationSummary: VerificationReport["summary"];
    confirmedCriticalHighFindings: number;
    partiallyConfirmedCriticalHighFindings: number;
    uncoveredDetections: Array<{
      findingId: string;
      method: "static-analysis" | "ast-rule" | "llm-assisted";
      confidence: number;
      tool?: string;
      detector?: string;
      file?: string;
      lines?: string;
      snippet?: string;
      note: string;
      reviewStatus: "unreviewed";
    }>;
    findings: Array<SecurityFinding & {
      verificationStatus: "confirmed" | "rejected" | "partial" | "inconclusive" | "not-returned";
    }>;
  };
  onchain: {
    riskScore: number;
    riskLevel: OnchainRiskReport["riskLevel"];
    signals: OnchainRiskReport["riskSignals"];
    independentReview: TokenRiskVerificationReport["conclusion"];
    reviewSummary: TokenRiskVerificationReport["summary"];
  };
  market?: {
    coverage: TokenRiskEnrichmentEvidence["coverage"];
    liquidity: {
      venue: "PancakeSwap";
      pair: string;
      pairExists: boolean;
      reserveTokenRaw?: string;
      reserveWrappedNativeRaw?: string;
      activeV3Pools: number;
    };
    quoteStatus: "quote-only" | "unavailable";
    sellabilityStatus: "partial" | "measured";
    recentTransactionsStatus: "measured" | "unavailable";
    holderConcentrationStatus: "unavailable" | "measured";
  };
  decision: {
    status: "avoid" | "high-caution" | "caution" | "no-high-risk-established";
    reasons: string[];
    requiredActions: string[];
  };
  limitations: string[];
}

export interface DueDiligenceCandidateEvidence {
  version: 1;
  experimentId: "full-due-diligence";
  synthesisKind: "same-target-candidate";
  status: "partial";
  settlement: {
    noNewPayment: true;
    status: "existing-paid-investigation-plus-local-unpaid-components";
    existingPaidComponent: {
      missionId: string;
      transactionHash: string;
      amount: string;
      currency: string;
    };
    reason: string;
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    sourceResolutionMs: number;
    audit: { startedAt: string; completedAt: string; durationMs: number };
    verification: { startedAt: string; completedAt: string; durationMs: number };
  };
  engines: {
    auditor: {
      serviceId: string;
      agentId: string;
      provider: string;
      model: string;
      status: "measured" | "unavailable";
      failureReason?: string;
    };
    verifier: {
      serviceId: string;
      agentId: string;
      engine: VerificationReport["engine"];
    };
  };
  artifacts: Record<string, string>;
  report: DueDiligenceReport;
}

export interface DueDiligenceInputs {
  securityInput: SecurityTaskInput;
  auditReport: AuditReport;
  verificationReport: VerificationReport;
  onchainReport: OnchainRiskReport;
  tokenRiskReview: TokenRiskVerificationReport;
  enrichment?: TokenRiskEnrichmentEvidence;
  provenance: DueDiligenceProvenance;
  auditFailureReason?: string;
  auditScope?: DueDiligenceReport["security"]["auditScope"];
  now(): Date;
}

function sha256Source(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function countVerificationSummary(report: VerificationReport): VerificationReport["summary"] {
  const count = (status: VerificationReport["verifications"][number]["status"]) =>
    report.verifications.filter((item) => item.status === status).length;
  return {
    confirmed: count("confirmed"),
    rejected: count("rejected"),
    partial: count("partial"),
    inconclusive: count("inconclusive"),
    missed: count("missed")
  };
}

function sameVerificationSummary(
  left: VerificationReport["summary"],
  right: VerificationReport["summary"]
): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof VerificationReport["summary"]] ===
      right[key as keyof VerificationReport["summary"]]
  );
}

function decisionStatus(input: {
  confirmedCritical: number;
  confirmedHigh: number;
  partialCritical: number;
  partialHigh: number;
  riskLevel: OnchainRiskReport["riskLevel"];
  reviewStatus: TokenRiskVerificationReport["conclusion"]["status"];
}): DueDiligenceReport["decision"]["status"] {
  if (input.confirmedCritical > 0 || input.reviewStatus === "rejected") return "avoid";
  if (
    input.confirmedHigh > 0 ||
    input.partialCritical > 0 ||
    input.partialHigh > 0 ||
    input.riskLevel === "high" ||
    input.riskLevel === "critical" ||
    input.reviewStatus === "partial"
  ) return "high-caution";
  if (input.riskLevel === "medium") return "caution";
  return "no-high-risk-established";
}

export function buildDueDiligenceReport(input: DueDiligenceInputs): DueDiligenceReport {
  const implementation = input.onchainReport.facts.proxy.implementation;
  if (!implementation) {
    throw new Error("Due diligence requires an onchain report with a resolved implementation");
  }
  if (input.securityInput.mode !== "verified-source" || !input.securityInput.contractAddress) {
    throw new Error("Due diligence requires explorer-verified source with a contract address");
  }
  if (input.securityInput.chainId !== input.onchainReport.chainId) {
    throw new Error("Verified source and onchain report use different chains");
  }
  if (input.securityInput.contractAddress.toLowerCase() !== implementation.toLowerCase()) {
    throw new Error("Verified source address does not match the onchain implementation");
  }
  if (sha256Source(input.securityInput.source) !== input.securityInput.sourceHash) {
    throw new Error("Verified source content does not match its source hash");
  }
  if (input.verificationReport.sourceHash !== input.securityInput.sourceHash) {
    throw new Error("Finding verification is not bound to the audited source hash");
  }
  if (input.provenance.audit === "unavailable-timeout" && !input.auditFailureReason) {
    throw new Error("Unavailable Auditor provenance requires a failure reason");
  }
  if (input.provenance.audit === "local-unpaid-scoped") {
    if (!input.auditScope) {
      throw new Error("Scoped Auditor provenance requires an audit scope");
    }
    if (input.auditScope.packageSourceHash !== input.securityInput.sourceHash) {
      throw new Error("Scoped Auditor package hash does not match the verified source package");
    }
  }
  const recomputedVerificationSummary = countVerificationSummary(input.verificationReport);
  if (!sameVerificationSummary(recomputedVerificationSummary, input.verificationReport.summary)) {
    throw new Error("Finding verification summary is internally inconsistent");
  }
  const investigationHash = tokenRiskReportHash(input.onchainReport);
  if (
    input.tokenRiskReview.sourceReportHash !== investigationHash ||
    input.tokenRiskReview.blockNumber !== input.onchainReport.blockNumber ||
    input.tokenRiskReview.target.toLowerCase() !== input.onchainReport.target.address.toLowerCase()
  ) {
    throw new Error("Token-risk review is not bound to the onchain investigation");
  }
  if (input.enrichment && (
    input.enrichment.source.reportHash !== investigationHash ||
    input.enrichment.source.blockNumber !== input.onchainReport.blockNumber ||
    input.enrichment.source.target.toLowerCase() !== input.onchainReport.target.address.toLowerCase()
  )) {
    throw new Error("Post-run enrichment is not bound to the onchain investigation");
  }

  const verifications = new Map(
    input.verificationReport.verifications.map((item) => [item.findingId, item.status])
  );
  const findings = input.auditReport.vulnerabilities.map((finding) => {
    const status = verifications.get(finding.findingId);
    return {
      ...finding,
      verificationStatus: status === "missed" ? "not-returned" as const : status ?? "not-returned" as const
    };
  });
  const uncoveredDetections = input.verificationReport.verifications
    .filter((verification) => verification.status === "missed")
    .map((verification) => ({
      findingId: verification.findingId,
      method: verification.method,
      confidence: verification.confidence,
      ...verification.evidence,
      reviewStatus: "unreviewed" as const
    }));
  const confirmedCritical = findings.filter((finding) =>
    finding.severity === "critical" &&
    finding.verificationStatus === "confirmed"
  ).length;
  const confirmedHigh = findings.filter((finding) =>
    finding.severity === "high" &&
    finding.verificationStatus === "confirmed"
  ).length;
  const partialCritical = findings.filter((finding) =>
    finding.severity === "critical" && finding.verificationStatus === "partial"
  ).length;
  const partialHigh = findings.filter((finding) =>
    finding.severity === "high" && finding.verificationStatus === "partial"
  ).length;
  const reasons: string[] = [];
  if (input.provenance.audit === "unavailable-timeout") {
    reasons.push("The large-source LLM Auditor timed out; compiler-backed detections were retained as uncovered signals.");
  }
  if (input.provenance.audit === "local-unpaid-scoped") {
    reasons.push("The LLM Auditor completed a first-party source review; dependency source units were covered only by compiler-backed analysis.");
  }
  const inconclusiveAuditorFindings = findings.filter(
    (finding) => finding.verificationStatus === "inconclusive"
  ).length;
  if (inconclusiveAuditorFindings > 0) {
    reasons.push(`${inconclusiveAuditorFindings} scoped LLM finding(s) remain inconclusive under deterministic verification.`);
  }
  const partiallyConfirmedFindings = findings.filter(
    (finding) => finding.verificationStatus === "partial"
  ).length;
  if (partiallyConfirmedFindings > 0) {
    reasons.push(`${partiallyConfirmedFindings} scoped LLM finding(s) have source structures partially confirmed; current exploitability remains unresolved.`);
  }
  if (uncoveredDetections.length > 0) {
    reasons.push(`${uncoveredDetections.length} compiler-backed static detection(s) remain unreviewed; they are not confirmed vulnerabilities.`);
  }
  if (confirmedCritical > 0) {
    reasons.push(`${confirmedCritical} critical source finding(s) were confirmed.`);
  }
  if (confirmedHigh > 0) {
    reasons.push(`${confirmedHigh} high source finding(s) were confirmed.`);
  }
  if (partialCritical + partialHigh > 0) {
    reasons.push(`${partialCritical + partialHigh} critical/high source finding(s) were only partially confirmed.`);
  }
  if (input.onchainReport.riskLevel === "high" || input.onchainReport.riskLevel === "critical") {
    reasons.push(`The independently replayed onchain report is ${input.onchainReport.riskLevel} risk at score ${input.onchainReport.riskScore}/100.`);
  }
  if (input.enrichment?.indexedData.holderConcentration.status === "unavailable") {
    reasons.push("Complete holder concentration remains unavailable.");
  }
  if (input.enrichment?.dex.coverage.sellability !== "measured") {
    reasons.push("A read-only DEX quote exists, but no executable sell was proven.");
  }
  if (reasons.length === 0) {
    reasons.push("No confirmed high-severity source finding or high onchain risk level was established.");
  }

  const requiredActions = [
    ...findings
      .filter((finding) => finding.verificationStatus !== "rejected")
      .map((finding) => finding.recommendation),
    ...(uncoveredDetections.length > 0
      ? ["Manually triage every uncovered static detection against the exact source unit before classifying it as a vulnerability or false positive."]
      : []),
    "Verify proxy admin and owner controls against a documented multisig/timelock policy.",
    ...(input.enrichment?.indexedData.holderConcentration.status === "unavailable"
      ? ["Obtain a complete indexed holder snapshot before relying on concentration claims."]
      : []),
    ...(input.enrichment?.dex.coverage.sellability !== "measured"
      ? ["Run an explicitly authorized fork simulation or test swap before claiming sellability."]
      : [])
  ];

  return {
    version: 1,
    experimentId: "full-due-diligence",
    status: "partial",
    generatedAt: input.now().toISOString(),
    target: {
      chainId: input.onchainReport.chainId,
      proxy: input.onchainReport.target.address,
      implementation,
      sourceName: input.securityInput.sourceName,
      sourceHash: input.securityInput.sourceHash,
      sourceMode: "verified-source",
      reportBlock: input.onchainReport.blockNumber
    },
    bindings: {
      sourceHashVerified: true,
      sourceAddressMatchesImplementation: true,
      findingVerificationMatchesSource: true,
      tokenReviewMatchesInvestigation: true,
      ...(input.enrichment ? { enrichmentMatchesInvestigation: true as const } : {})
    },
    provenance: input.provenance,
    security: {
      auditStatus: input.provenance.audit === "unavailable-timeout"
        ? "unavailable"
        : input.provenance.audit === "local-unpaid-scoped"
          ? "measured-partial"
          : "measured",
      ...(input.auditFailureReason ? { auditFailureReason: input.auditFailureReason } : {}),
      ...(input.auditScope ? { auditScope: input.auditScope } : {}),
      auditorFindings: findings.length,
      criticalHighFindings: findings.filter((finding) =>
        finding.severity === "critical" || finding.severity === "high"
      ).length,
      verificationSummary: input.verificationReport.summary,
      confirmedCriticalHighFindings: confirmedCritical + confirmedHigh,
      partiallyConfirmedCriticalHighFindings: partialCritical + partialHigh,
      uncoveredDetections,
      findings
    },
    onchain: {
      riskScore: input.onchainReport.riskScore,
      riskLevel: input.onchainReport.riskLevel,
      signals: input.onchainReport.riskSignals,
      independentReview: input.tokenRiskReview.conclusion,
      reviewSummary: input.tokenRiskReview.summary
    },
    ...(input.enrichment ? {
        market: {
          coverage: input.enrichment.coverage,
          liquidity: {
            venue: input.enrichment.dex.scope.venue,
            pair: input.enrichment.dex.v2.pair,
            pairExists: input.enrichment.dex.v2.pairExists,
            reserveTokenRaw: input.enrichment.dex.v2.reserveTokenRaw,
            reserveWrappedNativeRaw: input.enrichment.dex.v2.reserveWrappedNativeRaw,
            activeV3Pools: input.enrichment.dex.v3.pools.filter((pool) =>
              BigInt(pool.liquidityRaw ?? "0") > 0n
            ).length
          },
          quoteStatus: input.enrichment.dex.quote.status,
          sellabilityStatus: input.enrichment.dex.coverage.sellability,
          recentTransactionsStatus: input.enrichment.indexedData.recentTransactions.status,
          holderConcentrationStatus: input.enrichment.indexedData.holderConcentration.status
        }
      } : {}),
    decision: {
      status: decisionStatus({
        confirmedCritical,
        confirmedHigh,
        partialCritical,
        partialHigh,
        riskLevel: input.onchainReport.riskLevel,
        reviewStatus: input.tokenRiskReview.conclusion.status
      }),
      reasons,
      requiredActions: [...new Set(requiredActions)]
    },
    limitations: [
      "This candidate reuses a previously paid onchain investigation; it is not a new end-to-end paid Experiment 3 mission.",
      ...(input.provenance.audit === "local-unpaid"
        ? ["The source audit was executed locally without a new service payment or signed x402 receipt."]
        : []),
      ...(input.provenance.audit === "local-unpaid-scoped" && input.auditScope
        ? [
            "The LLM audit was executed locally without a new service payment or signed x402 receipt.",
            input.auditScope.limitation
          ]
        : []),
      ...(input.provenance.audit === "unavailable-timeout"
        ? ["The LLM Auditor timed out; zero Auditor findings must not be interpreted as a clean audit."]
        : []),
      ...(input.provenance.findingVerification === "local-unpaid"
        ? ["Finding verification was executed locally without a new service payment or signed x402 receipt."]
        : []),
      "The report remains partial until controlled baseline evidence and independent human review are recorded.",
      ...(input.enrichment?.limitations ?? [])
    ]
  };
}

export async function loadDueDiligenceCandidate(
  evidencePath: string
): Promise<DueDiligenceCandidateEvidence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath, "utf8")) as DueDiligenceCandidateEvidence;
    if (
      parsed.version !== 1 ||
      parsed.experimentId !== "full-due-diligence" ||
      parsed.synthesisKind !== "same-target-candidate" ||
      parsed.status !== "partial" ||
      parsed.settlement?.noNewPayment !== true ||
      parsed.report?.version !== 1 ||
      parsed.report.experimentId !== "full-due-diligence" ||
      parsed.report.status !== "partial" ||
      parsed.report.target?.sourceMode !== "verified-source" ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.report.target.sourceHash) ||
      !Object.values(parsed.report.bindings ?? {}).every((bound) => bound === true) ||
      !Number.isFinite(parsed.timing?.durationMs) ||
      parsed.timing.durationMs < 0 ||
      !Array.isArray(parsed.report.security?.uncoveredDetections) ||
      parsed.report.security.verificationSummary.missed !==
        parsed.report.security.uncoveredDetections.length ||
      !Array.isArray(parsed.report.limitations)
    ) {
      throw new Error("Due-diligence candidate evidence has an unsupported format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
