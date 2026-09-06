import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AuditReport,
  OnchainRiskReport,
  ServiceInfo,
  TokenRiskVerificationReport,
  VerificationReport
} from "@rebel/shared";
import { HunterError } from "./errors.js";

const securityFindingSchema = z.object({
  findingId: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  description: z.string().min(1),
  evidence: z.object({
    file: z.string().optional(),
    lines: z.string().optional(),
    snippet: z.string().optional(),
    bytecodeOffset: z.string().optional()
  }),
  exploitScenario: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const auditReportSchema = z.object({
  vulnerabilities: z.array(securityFindingSchema)
});

const verificationReportSchema = z.object({
  sourceName: z.string().min(1),
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  engine: z.object({
    method: z.enum(["static-analysis", "ast-rule"]),
    name: z.string().min(1),
    version: z.string().optional(),
    fallbackReason: z.string().optional()
  }),
  verifications: z.array(
    z.object({
      findingId: z.string().min(1),
      status: z.enum(["confirmed", "rejected", "partial", "inconclusive", "missed"]),
      method: z.enum(["static-analysis", "ast-rule", "llm-assisted"]),
      confidence: z.number().min(0).max(1),
      evidence: z.object({
        tool: z.string().optional(),
        detector: z.string().optional(),
        lines: z.string().optional(),
        snippet: z.string().optional(),
        note: z.string().min(1)
      }),
      verifierAgentId: z.string().min(1)
    })
  ),
  summary: z.object({
    confirmed: z.number().int().min(0),
    rejected: z.number().int().min(0),
    partial: z.number().int().min(0),
    inconclusive: z.number().int().min(0),
    missed: z.number().int().min(0)
  })
});

const onchainRiskReportSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  target: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    classification: z.enum(["eoa", "contract", "erc20"]),
    bytecodeSize: z.number().int().nonnegative(),
    bytecodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()
  }),
  observedAt: z.string().datetime(),
  blockNumber: z.number().int().nonnegative(),
  sources: z.array(z.object({
    kind: z.literal("rpc"),
    endpoint: z.string().min(1),
    methods: z.array(z.string().min(1)),
    observedAt: z.string().datetime()
  })).min(1),
  facts: z.object({
    nativeBalanceWei: z.string().regex(/^\d+$/),
    transactionCount: z.string().regex(/^\d+$/),
    token: z.object({
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().int().min(0).max(255).optional(),
      totalSupply: z.string().regex(/^\d+$/).optional()
    }).optional(),
    ownership: z.object({
      owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      probe: z.enum(["owner()", "getOwner()", "unavailable"]),
      renounced: z.boolean().optional()
    }),
    proxy: z.object({
      standard: z.literal("eip-1967"),
      implementation: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      admin: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      implementationBytecodeSize: z.number().int().nonnegative().optional(),
      implementationBytecodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()
    })
  }),
  riskSignals: z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    title: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.number().min(0).max(1)
  })),
  riskScore: z.number().int().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  coverage: z.object({
    accountState: z.literal("measured"),
    contractBytecode: z.literal("measured"),
    tokenMetadata: z.enum(["measured", "not-applicable", "partial"]),
    ownership: z.enum(["measured", "unavailable"]),
    proxySlots: z.literal("measured"),
    holderConcentration: z.literal("not-measured"),
    liquidity: z.literal("not-measured"),
    recentTransactions: z.literal("not-measured")
  }),
  limitations: z.array(z.string().min(1)),
  recommendation: z.string().min(1)
});

const tokenRiskVerificationReportSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  sourceReportHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceObservedAt: z.string().datetime(),
  verifiedAt: z.string().datetime(),
  blockNumber: z.number().int().nonnegative(),
  engine: z.object({
    method: z.literal("independent-rpc-replay"),
    name: z.literal("agora-token-risk-verifier"),
    version: z.literal("1"),
    endpoint: z.string().min(1),
    independentTransport: z.boolean()
  }),
  checks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["confirmed", "mismatch", "unavailable"]),
    expected: z.string(),
    actual: z.string(),
    evidence: z.string().min(1)
  })).min(1),
  summary: z.object({
    confirmed: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    total: z.number().int().positive()
  }),
  conclusion: z.object({
    status: z.enum(["confirmed", "partial", "rejected"]),
    originalRiskScore: z.number().int().min(0).max(100),
    replayedRiskScore: z.number().int().min(0).max(100),
    originalRiskLevel: z.enum(["low", "medium", "high", "critical"]),
    replayedRiskLevel: z.enum(["low", "medium", "high", "critical"])
  }),
  limitations: z.array(z.string().min(1))
});

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

export function tokenRiskReportHash(report: OnchainRiskReport): string {
  return `sha256:${createHash("sha256").update(stableJson(report)).digest("hex")}`;
}

function parseJson(raw: string, code: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HunterError(502, code, `${label} did not return valid JSON`);
  }
}

export function parseAuditReport(raw: string): AuditReport {
  const parsed = auditReportSchema.safeParse(parseJson(raw, "AUDIT_REPORT_INVALID", "Auditor"));
  if (!parsed.success) {
    throw new HunterError(
      502,
      "AUDIT_REPORT_INVALID",
      "Auditor output does not match the required SecurityFinding schema",
      parsed.error.flatten()
    );
  }
  const findingIds = parsed.data.vulnerabilities.map((finding) => finding.findingId);
  if (new Set(findingIds).size !== findingIds.length) {
    throw new HunterError(
      502,
      "AUDIT_REPORT_INVALID",
      "Auditor output contains duplicate findingId values"
    );
  }
  return parsed.data as AuditReport;
}

export function parseOnchainRiskReport(raw: string): OnchainRiskReport {
  const parsed = onchainRiskReportSchema.safeParse(
    parseJson(raw, "ONCHAIN_RISK_REPORT_INVALID", "Investigator")
  );
  if (!parsed.success) {
    throw new HunterError(
      502,
      "ONCHAIN_RISK_REPORT_INVALID",
      "Investigator output does not match the required onchain-risk-report-v1 schema",
      parsed.error.flatten()
    );
  }
  return parsed.data as OnchainRiskReport;
}

export function parseTokenRiskVerificationReport(
  raw: string,
  sourceReport: OnchainRiskReport
): TokenRiskVerificationReport {
  const parsed = tokenRiskVerificationReportSchema.safeParse(
    parseJson(raw, "TOKEN_RISK_VERIFICATION_INVALID", "Token Risk Verifier")
  );
  if (!parsed.success) {
    throw new HunterError(
      502,
      "TOKEN_RISK_VERIFICATION_INVALID",
      "Token Risk Verifier output does not match token-risk-verification-v1",
      parsed.error.flatten()
    );
  }
  if (
    parsed.data.chainId !== sourceReport.chainId ||
    parsed.data.target.toLowerCase() !== sourceReport.target.address.toLowerCase() ||
    parsed.data.blockNumber !== sourceReport.blockNumber ||
    parsed.data.sourceObservedAt !== sourceReport.observedAt ||
    parsed.data.sourceReportHash !== tokenRiskReportHash(sourceReport)
  ) {
    throw new HunterError(
      502,
      "TOKEN_RISK_VERIFICATION_SOURCE_MISMATCH",
      "Token Risk Verifier output is not bound to the Investigator report"
    );
  }
  const ids = parsed.data.checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) {
    throw new HunterError(
      502,
      "TOKEN_RISK_VERIFICATION_INVALID",
      "Token Risk Verifier output contains duplicate check ids"
    );
  }
  const recomputed = {
    confirmed: parsed.data.checks.filter((check) => check.status === "confirmed").length,
    mismatched: parsed.data.checks.filter((check) => check.status === "mismatch").length,
    unavailable: parsed.data.checks.filter((check) => check.status === "unavailable").length,
    total: parsed.data.checks.length
  };
  for (const [key, value] of Object.entries(recomputed)) {
    if (parsed.data.summary[key as keyof typeof recomputed] !== value) {
      throw new HunterError(
        502,
        "TOKEN_RISK_VERIFICATION_INVALID",
        `Token Risk Verifier summary does not match ${key} checks`
      );
    }
  }
  return parsed.data as TokenRiskVerificationReport;
}

export function parseVerificationReport(
  raw: string,
  expectedSourceHash: string,
  expected: { findingIds?: string[]; verifierAgentId?: string } = {}
): VerificationReport {
  const parsed = verificationReportSchema.safeParse(
    parseJson(raw, "VERIFICATION_REPORT_INVALID", "Verifier")
  );
  if (!parsed.success) {
    throw new HunterError(
      502,
      "VERIFICATION_REPORT_INVALID",
      "Verifier output does not match the required verification schema",
      parsed.error.flatten()
    );
  }
  if (parsed.data.sourceHash !== expectedSourceHash) {
    throw new HunterError(
      502,
      "VERIFICATION_SOURCE_MISMATCH",
      "Verifier report is not bound to the audited source hash",
      { expectedSourceHash, actualSourceHash: parsed.data.sourceHash }
    );
  }
  const verificationIds = parsed.data.verifications.map((verification) => verification.findingId);
  if (new Set(verificationIds).size !== verificationIds.length) {
    throw new HunterError(
      502,
      "VERIFICATION_REPORT_INVALID",
      "Verifier output contains duplicate findingId values"
    );
  }
  const expectedIds = new Set(expected.findingIds ?? []);
  for (const findingId of expectedIds) {
    if (!verificationIds.includes(findingId)) {
      throw new HunterError(
        502,
        "VERIFICATION_REPORT_INVALID",
        `Verifier output omitted auditor finding ${findingId}`
      );
    }
  }
  for (const verification of parsed.data.verifications) {
    if (!expectedIds.has(verification.findingId) && verification.status !== "missed") {
      throw new HunterError(
        502,
        "VERIFICATION_REPORT_INVALID",
        `Unknown verifier finding ${verification.findingId} must use missed status`
      );
    }
    if (
      expected.verifierAgentId &&
      verification.verifierAgentId !== expected.verifierAgentId
    ) {
      throw new HunterError(
        502,
        "VERIFICATION_REPORT_INVALID",
        "Verifier output contains a mismatched verifierAgentId"
      );
    }
    if (verification.method !== parsed.data.engine.method) {
      throw new HunterError(
        502,
        "VERIFICATION_REPORT_INVALID",
        "Verifier item method does not match the declared engine method"
      );
    }
  }
  const count = (status: typeof parsed.data.verifications[number]["status"]) =>
    parsed.data.verifications.filter((verification) => verification.status === status).length;
  const recomputed = {
    confirmed: count("confirmed"),
    rejected: count("rejected"),
    partial: count("partial"),
    inconclusive: count("inconclusive"),
    missed: count("missed")
  };
  for (const [status, value] of Object.entries(recomputed)) {
    if (parsed.data.summary[status as keyof typeof recomputed] !== value) {
      throw new HunterError(
        502,
        "VERIFICATION_REPORT_INVALID",
        `Verifier summary count does not match ${status} entries`
      );
    }
  }
  return parsed.data as VerificationReport;
}

function sameIdentity(left: ServiceInfo, right: ServiceInfo): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (left.agentId && right.agentId && left.agentId === right.agentId) {
    return true;
  }
  return left.provider.toLowerCase() === right.provider.toLowerCase();
}

export function independentVerifierCandidates(
  services: ServiceInfo[],
  auditor: ServiceInfo
): ServiceInfo[] {
  return services.filter(
    (service) =>
      (service.taskType === "finding-verification" ||
        service.skills?.includes("finding-verification")) &&
      !sameIdentity(service, auditor)
  );
}

export function independentRiskVerifierCandidates(
  services: ServiceInfo[],
  investigator: ServiceInfo
): ServiceInfo[] {
  return services.filter(
    (service) =>
      (service.taskType === "token-risk-verification" ||
        service.skills?.includes("token-risk-verification")) &&
      !sameIdentity(service, investigator)
  );
}
