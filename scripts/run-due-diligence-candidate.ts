import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AuditReport,
  OnchainRiskReport,
  SecurityTaskInput,
  ServiceInfo
} from "@rebel/shared";
import {
  loadTokenRiskEnrichment,
  loadTokenRiskSecurityReview
} from "../agents/hunter/src/advantage-evaluator.js";
import { buildDueDiligenceReport } from "../agents/hunter/src/due-diligence.js";
import { resolveSecurityTaskInput } from "../agents/hunter/src/security-input.js";
import { parseAuditReport, parseVerificationReport } from "../agents/hunter/src/security-pipeline.js";
import {
  buildFirstPartyAuditTask,
  runProductionAudit,
  type ScopedAuditTask
} from "../agents/writer/src/auditor-runner.js";
import { writerConfig } from "../agents/writer/src/config.js";
import { runDeterministicVerification } from "../agents/writer/src/verification/deterministic-verifier.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-3-due-diligence");
const tokenRiskDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const paidRunPath = path.join(tokenRiskDirectory, "paid-run-output.json");
const securityReviewPath = path.join(tokenRiskDirectory, "security-review-output.json");
const enrichmentPath = path.join(tokenRiskDirectory, "indexed-enrichment-output.json");
const dynamicServicesPath = path.join(repositoryRoot, "registry/dynamic-services.json");
const inputPath = path.join(experimentDirectory, "verified-source-input.json");
const auditorOutputPath = path.join(experimentDirectory, "auditor-output.json");
const verifierOutputPath = path.join(experimentDirectory, "verifier-output.json");
const candidateOutputPath = path.join(experimentDirectory, "candidate-output.json");
const runtimeTriageOutputPath = path.join(experimentDirectory, "runtime-triage-output.json");

interface AuditTiming {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface ReusableAuditorEvidence {
  version: 1;
  sourceHash: string;
  packageSourceHash: string;
  targetImplementation: string;
  auditScope: ScopedAuditTask["scope"];
  timing: AuditTiming;
  engine: {
    serviceId: string;
    agentId: string;
    provider: string;
    model: string;
    status: "measured";
  };
  report: AuditReport;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readServiceAgentIds(): Promise<{ auditorAgentId: string; verifierAgentId: string }> {
  const dynamic = JSON.parse(await readFile(dynamicServicesPath, "utf8")) as {
    services?: Array<{ agentId?: unknown; service?: Partial<ServiceInfo> }>;
  };
  const auditor = dynamic.services?.find((entry) => entry.service?.id === "auditor-v1");
  const verifier = dynamic.services?.find((entry) => entry.service?.id === "verifier-v1");
  if (typeof auditor?.agentId !== "string" || !auditor.agentId) {
    throw new Error("Dynamic registry does not contain the auditor-v1 identity");
  }
  if (typeof verifier?.agentId !== "string" || !verifier.agentId) {
    throw new Error("Dynamic registry does not contain the independent verifier-v1 identity");
  }
  return { auditorAgentId: auditor.agentId, verifierAgentId: verifier.agentId };
}

async function resolveCandidateSecurityInput(
  implementation: string,
  chainId: number
): Promise<SecurityTaskInput> {
  if (process.env.DUE_DILIGENCE_USE_CACHED_SOURCE !== "true") {
    return resolveSecurityTaskInput(implementation, { chainId });
  }
  const cached = JSON.parse(await readFile(inputPath, "utf8")) as SecurityTaskInput;
  if (
    cached.mode !== "verified-source" ||
    cached.chainId !== chainId ||
    cached.contractAddress?.toLowerCase() !== implementation.toLowerCase() ||
    !cached.sources ||
    !/^sha256:[0-9a-f]{64}$/.test(cached.sourceHash)
  ) {
    throw new Error("Cached verified source is not bound to the requested chain and implementation");
  }
  return cached;
}

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isAuditTiming(value: unknown): value is AuditTiming {
  if (!value || typeof value !== "object") return false;
  const timing = value as Partial<AuditTiming>;
  return typeof timing.startedAt === "string" &&
    !Number.isNaN(Date.parse(timing.startedAt)) &&
    typeof timing.completedAt === "string" &&
    !Number.isNaN(Date.parse(timing.completedAt)) &&
    typeof timing.durationMs === "number" &&
    Number.isFinite(timing.durationMs) &&
    timing.durationMs >= 0;
}

async function loadReusableAuditorEvidence(
  securityInput: SecurityTaskInput,
  implementation: string,
  expectedAgentId: string
): Promise<{ evidence: ReusableAuditorEvidence; scopedAudit: ScopedAuditTask }> {
  const candidate = JSON.parse(await readFile(auditorOutputPath, "utf8")) as Record<string, unknown>;
  const scopedAudit = buildFirstPartyAuditTask(securityInput);
  const expectedScope = scopedAudit.scope;
  const scope = candidate.auditScope as Partial<ScopedAuditTask["scope"]> | undefined;
  const engine = candidate.engine as ReusableAuditorEvidence["engine"] | undefined;
  if (
    candidate.version !== 1 ||
    candidate.packageSourceHash !== securityInput.sourceHash ||
    candidate.sourceHash !== expectedScope.scopeSourceHash ||
    typeof candidate.targetImplementation !== "string" ||
    candidate.targetImplementation.toLowerCase() !== implementation.toLowerCase() ||
    !scope ||
    scope.kind !== expectedScope.kind ||
    scope.packageSourceHash !== expectedScope.packageSourceHash ||
    scope.scopeSourceHash !== expectedScope.scopeSourceHash ||
    scope.sourceBytes !== expectedScope.sourceBytes ||
    scope.limitation !== expectedScope.limitation ||
    !sameStringArray(scope.includedSourceUnits, expectedScope.includedSourceUnits) ||
    !sameStringArray(scope.omittedDependencySourceUnits, expectedScope.omittedDependencySourceUnits) ||
    !isAuditTiming(candidate.timing) ||
    !engine ||
    engine.serviceId !== "auditor-v1" ||
    engine.agentId !== expectedAgentId ||
    engine.status !== "measured" ||
    typeof engine.provider !== "string" ||
    !engine.provider ||
    typeof engine.model !== "string" ||
    !engine.model
  ) {
    throw new Error("Reusable Auditor evidence is not bound to the current source, scope, target, and service identity");
  }
  const report = parseAuditReport(JSON.stringify(candidate.report));
  return {
    scopedAudit,
    evidence: {
      version: 1,
      sourceHash: candidate.sourceHash,
      packageSourceHash: candidate.packageSourceHash,
      targetImplementation: candidate.targetImplementation,
      auditScope: scope as ScopedAuditTask["scope"],
      timing: candidate.timing,
      engine,
      report
    }
  };
}

async function main(): Promise<void> {
  if (process.env.SERVICE_PROFILE !== "auditor") {
    throw new Error("Run this script with SERVICE_PROFILE=auditor to bind the local Auditor profile");
  }
  const paidRun = JSON.parse(await readFile(paidRunPath, "utf8")) as {
    mission?: { missionId?: unknown };
    payment?: {
      transaction?: unknown;
      amount?: {
        amount?: unknown;
        asset?: { symbol?: unknown };
      };
    };
    report?: OnchainRiskReport;
  };
  if (!paidRun.report || paidRun.report.version !== 1) {
    throw new Error("Experiment 2 paid evidence does not contain an onchain report");
  }
  const implementation = paidRun.report.facts.proxy.implementation;
  if (!implementation) {
    throw new Error("Experiment 2 report does not resolve the proxy implementation");
  }
  const [securityReview, enrichment, serviceAgentIds] = await Promise.all([
    loadTokenRiskSecurityReview(securityReviewPath),
    loadTokenRiskEnrichment(enrichmentPath),
    readServiceAgentIds()
  ]);
  const { auditorAgentId, verifierAgentId } = serviceAgentIds;
  if (!securityReview) throw new Error("Experiment 2 independent Security Agent review is missing");
  if (!enrichment) throw new Error("Experiment 2 indexed/DEX enrichment is missing");

  const startedAt = new Date();
  const totalStarted = performance.now();
  const sourceStarted = performance.now();
  const securityInput = await resolveCandidateSecurityInput(
    implementation,
    paidRun.report.chainId
  );
  const sourceDurationMs = performance.now() - sourceStarted;
  const runtimeTriage = JSON.parse(await readFile(runtimeTriageOutputPath, "utf8")) as {
    version?: unknown;
    source?: { sourceHash?: unknown; target?: unknown };
  };
  if (
    runtimeTriage.version !== 1 ||
    runtimeTriage.source?.sourceHash !== securityInput.sourceHash ||
    typeof runtimeTriage.source?.target !== "string" ||
    runtimeTriage.source.target.toLowerCase() !== paidRun.report.target.address.toLowerCase()
  ) {
    throw new Error("Runtime triage evidence is not bound to the current source package and proxy target");
  }

  const auditStartedAt = new Date();
  const auditStarted = performance.now();
  let auditReport: AuditReport;
  let auditFailureReason: string | undefined;
  let scopedAudit: ScopedAuditTask | undefined;
  let reusedAuditorEvidence: ReusableAuditorEvidence | undefined;
  if (process.env.DUE_DILIGENCE_REUSE_AUDITOR_OUTPUT === "true") {
    const reusable = await loadReusableAuditorEvidence(
      securityInput,
      implementation,
      auditorAgentId
    );
    scopedAudit = reusable.scopedAudit;
    reusedAuditorEvidence = reusable.evidence;
    auditReport = reusable.evidence.report;
  } else if (process.env.DUE_DILIGENCE_SKIP_AUDITOR === "true") {
    auditFailureReason = "Skipped after two prior five-minute large-source Auditor timeouts.";
    auditReport = { vulnerabilities: [] };
  } else {
    try {
      scopedAudit = buildFirstPartyAuditTask(securityInput);
      const auditRaw = await runProductionAudit(scopedAudit.taskInput, "en-US");
      auditReport = parseAuditReport(auditRaw);
    } catch (error) {
      auditFailureReason = error instanceof Error ? error.message : String(error);
      auditReport = { vulnerabilities: [] };
    }
  }
  const auditCompletedAt = new Date();
  const auditDurationMs = performance.now() - auditStarted;
  const auditTiming: AuditTiming = reusedAuditorEvidence?.timing ?? {
    startedAt: auditStartedAt.toISOString(),
    completedAt: auditCompletedAt.toISOString(),
    durationMs: Number(auditDurationMs.toFixed(3))
  };

  const verificationStartedAt = new Date();
  const verificationStarted = performance.now();
  const verificationReport = runDeterministicVerification(JSON.stringify({
    source: securityInput.source,
    sourceName: securityInput.sourceName,
    sources: securityInput.sources,
    remappings: securityInput.remappings,
    findings: auditReport.vulnerabilities
  }), verifierAgentId);
  const verificationCompletedAt = new Date();
  const verificationDurationMs = performance.now() - verificationStarted;
  parseVerificationReport(JSON.stringify(verificationReport), securityInput.sourceHash, {
    findingIds: auditReport.vulnerabilities.map((finding) => finding.findingId),
    verifierAgentId
  });

  const dueDiligence = buildDueDiligenceReport({
    securityInput,
    auditReport,
    verificationReport,
    onchainReport: paidRun.report,
    tokenRiskReview: securityReview.review,
    enrichment,
    provenance: {
      audit: auditFailureReason ? "unavailable-timeout" : "local-unpaid-scoped",
      findingVerification: "local-unpaid",
      onchainInvestigation: "paid-mission",
      tokenRiskReview: "local-unpaid",
      enrichment: "local-unpaid"
    },
    ...(auditFailureReason ? { auditFailureReason } : {}),
    ...(scopedAudit && !auditFailureReason ? { auditScope: scopedAudit.scope } : {}),
    now: () => new Date()
  });
  const completedAt = new Date();
  const evidence = {
    version: 1,
    experimentId: "full-due-diligence",
    synthesisKind: "same-target-candidate",
    status: "partial",
    settlement: {
      noNewPayment: true,
      status: "existing-paid-investigation-plus-local-unpaid-components",
      existingPaidComponent: {
        missionId: typeof paidRun.mission?.missionId === "string" ? paidRun.mission.missionId : "unknown",
        transactionHash: typeof paidRun.payment?.transaction === "string"
          ? paidRun.payment.transaction
          : "unknown",
        amount: typeof paidRun.payment?.amount?.amount === "string"
          ? paidRun.payment.amount.amount
          : "unknown",
        currency: typeof paidRun.payment?.amount?.asset?.symbol === "string"
          ? paidRun.payment.amount.asset.symbol
          : "unknown"
      },
      reason: "The source audit and finding verification were local candidate runs; no new Authority or x402 payment was authorized."
    },
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number((performance.now() - totalStarted).toFixed(3)),
      sourceResolutionMs: Number(sourceDurationMs.toFixed(3)),
      audit: {
        ...auditTiming,
        ...(reusedAuditorEvidence
          ? {
              evidenceReused: true,
              reusedAt: auditCompletedAt.toISOString(),
              reuseValidationMs: Number(auditDurationMs.toFixed(3))
            }
          : {})
      },
      verification: {
        startedAt: verificationStartedAt.toISOString(),
        completedAt: verificationCompletedAt.toISOString(),
        durationMs: Number(verificationDurationMs.toFixed(3))
      }
    },
    engines: {
      auditor: {
        serviceId: "auditor-v1",
        agentId: auditorAgentId,
        provider: reusedAuditorEvidence?.engine.provider ?? writerConfig.llm.provider,
        model: reusedAuditorEvidence?.engine.model ?? writerConfig.llm.model,
        status: auditFailureReason ? "unavailable" : "measured",
        ...(reusedAuditorEvidence ? { evidenceReused: true } : {}),
        ...(scopedAudit && !auditFailureReason ? { scope: scopedAudit.scope } : {}),
        ...(auditFailureReason ? { failureReason: auditFailureReason } : {})
      },
      verifier: {
        serviceId: "verifier-v1",
        agentId: verifierAgentId,
        engine: verificationReport.engine
      },
      investigator: {
        serviceId: "investigator-v1",
        missionId: typeof paidRun.mission?.missionId === "string" ? paidRun.mission.missionId : "unknown"
      },
      tokenRiskReviewer: securityReview.reviewer,
      dexEnrichment: enrichment.dex.engine
    },
    artifacts: {
      verifiedSource: "verified-source-input.json",
      auditorOutput: "auditor-output.json",
      verifierOutput: "verifier-output.json",
      onchainInvestigation: "../experiment-2-token-risk/paid-run-output.json",
      tokenRiskReview: "../experiment-2-token-risk/security-review-output.json",
      enrichment: "../experiment-2-token-risk/indexed-enrichment-output.json",
      runtimeTriage: "runtime-triage-output.json"
    },
    report: dueDiligence
  };

  await mkdir(experimentDirectory, { recursive: true });
  await Promise.all([
    writeJsonAtomic(inputPath, securityInput),
    writeJsonAtomic(auditorOutputPath, {
      version: 1,
      settlement: { status: "not-paid", reason: "Local Experiment 3 candidate run" },
      sourceHash: scopedAudit && !auditFailureReason
        ? scopedAudit.scope.scopeSourceHash
        : securityInput.sourceHash,
      packageSourceHash: securityInput.sourceHash,
      ...(scopedAudit && !auditFailureReason ? { auditScope: scopedAudit.scope } : {}),
      targetImplementation: implementation,
      timing: evidence.timing.audit,
      engine: evidence.engines.auditor,
      report: auditReport,
      warning: auditFailureReason
        ? "Auditor unavailable; zero findings is not a clean-audit result."
        : undefined,
      ...(reusedAuditorEvidence
        ? { reusedAt: auditCompletedAt.toISOString(), originalEvidencePreserved: true }
        : {})
    }),
    writeJsonAtomic(verifierOutputPath, {
      version: 1,
      settlement: { status: "not-paid", reason: "Local Experiment 3 candidate run" },
      sourceHash: securityInput.sourceHash,
      timing: evidence.timing.verification,
      engine: evidence.engines.verifier,
      report: verificationReport
    }),
    writeJsonAtomic(candidateOutputPath, evidence)
  ]);

  console.log(JSON.stringify({
    candidateOutputPath,
    target: dueDiligence.target,
    bindings: dueDiligence.bindings,
    auditorFindings: dueDiligence.security.auditorFindings,
    verificationSummary: dueDiligence.security.verificationSummary,
    onchainRisk: {
      score: dueDiligence.onchain.riskScore,
      level: dueDiligence.onchain.riskLevel,
      review: dueDiligence.onchain.independentReview.status
    },
    decision: dueDiligence.decision.status,
    noNewPayment: evidence.settlement.noNewPayment,
    durationMs: evidence.timing.durationMs
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
