import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type {
  AuditReport,
  OnchainRiskReport,
  SecurityTaskInput,
  TokenRiskVerificationReport,
  VerificationReport
} from "@rebel/shared";
import { buildDueDiligenceReport } from "./due-diligence.js";
import { tokenRiskReportHash } from "./security-pipeline.js";

const PROXY = "0x1111111111111111111111111111111111111111";
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222";
const SOURCE = "pragma solidity ^0.8.20; contract StablecoinV2 {}";
const SOURCE_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;

function fixtures() {
  const securityInput: SecurityTaskInput = {
    chainId: 97,
    mode: "verified-source",
    sourceName: "StablecoinV2.sol",
    source: SOURCE,
    sourceHash: SOURCE_HASH,
    contractAddress: IMPLEMENTATION
  };
  const auditReport: AuditReport = {
    vulnerabilities: [{
      findingId: "admin-mint",
      title: "Unbounded admin mint",
      severity: "high",
      description: "Admin can mint.",
      evidence: { file: "StablecoinV2.sol", lines: "1", snippet: "contract StablecoinV2" },
      exploitScenario: "A compromised admin mints supply.",
      recommendation: "Use a capped, delayed mint policy.",
      confidence: 0.8
    }]
  };
  const verificationReport: VerificationReport = {
    sourceName: securityInput.sourceName,
    sourceHash: SOURCE_HASH,
    engine: { method: "ast-rule", name: "test", version: "1" },
    verifications: [{
      findingId: "admin-mint",
      status: "partial",
      method: "ast-rule",
      confidence: 0.7,
      evidence: { note: "Access policy requires manual review." },
      verifierAgentId: "97:verifier"
    }],
    summary: { confirmed: 0, rejected: 0, partial: 1, inconclusive: 0, missed: 0 }
  };
  const onchainReport: OnchainRiskReport = {
    version: 1,
    chainId: 97,
    target: { address: PROXY, classification: "erc20", bytecodeSize: 1 },
    observedAt: "2026-09-01T00:00:00.000Z",
    blockNumber: 123,
    sources: [{ kind: "rpc", endpoint: "https://rpc.example", methods: ["eth_call"], observedAt: "2026-09-01T00:00:00.000Z" }],
    facts: {
      nativeBalanceWei: "0",
      transactionCount: "1",
      token: { symbol: "U", decimals: 18, totalSupply: "1000" },
      ownership: { probe: "owner()", owner: IMPLEMENTATION },
      proxy: { standard: "eip-1967", implementation: IMPLEMENTATION }
    },
    riskSignals: [{ id: "mint", severity: "high", title: "Mint", evidence: "selector", confidence: 0.65 }],
    riskScore: 51,
    riskLevel: "high",
    coverage: {
      accountState: "measured",
      contractBytecode: "measured",
      tokenMetadata: "measured",
      ownership: "measured",
      proxySlots: "measured",
      holderConcentration: "not-measured",
      liquidity: "not-measured",
      recentTransactions: "not-measured"
    },
    limitations: [],
    recommendation: "Review"
  };
  const tokenRiskReview: TokenRiskVerificationReport = {
    version: 1,
    chainId: 97,
    target: PROXY,
    sourceReportHash: tokenRiskReportHash(onchainReport),
    sourceObservedAt: onchainReport.observedAt,
    verifiedAt: "2026-09-01T00:01:00.000Z",
    blockNumber: 123,
    engine: {
      method: "independent-rpc-replay",
      name: "agora-token-risk-verifier",
      version: "1",
      endpoint: "https://independent.example",
      independentTransport: true
    },
    checks: [{ id: "risk-score", status: "confirmed", expected: "51", actual: "51", evidence: "replayed" }],
    summary: { confirmed: 1, mismatched: 0, unavailable: 0, total: 1 },
    conclusion: {
      status: "confirmed",
      originalRiskScore: 51,
      replayedRiskScore: 51,
      originalRiskLevel: "high",
      replayedRiskLevel: "high"
    },
    limitations: []
  };
  return { securityInput, auditReport, verificationReport, onchainReport, tokenRiskReview };
}

test("builds a source-, implementation-, and report-bound due-diligence candidate", () => {
  const report = buildDueDiligenceReport({
    ...fixtures(),
    provenance: {
      audit: "local-unpaid",
      findingVerification: "local-unpaid",
      onchainInvestigation: "paid-mission",
      tokenRiskReview: "local-unpaid"
    },
    now: () => new Date("2026-09-01T00:02:00.000Z")
  });
  assert.equal(report.target.implementation, IMPLEMENTATION);
  assert.equal(report.bindings.sourceHashVerified, true);
  assert.equal(report.security.confirmedCriticalHighFindings, 0);
  assert.equal(report.security.partiallyConfirmedCriticalHighFindings, 1);
  assert.equal(report.decision.status, "high-caution");
  assert.ok(report.decision.requiredActions.includes("Use a capped, delayed mint policy."));
  assert.match(report.limitations.join(" "), /not a new end-to-end paid Experiment 3 mission/);
});

test("retains unmatched static detections as unreviewed signals, not confirmed vulnerabilities", () => {
  const input = fixtures();
  input.auditReport = { vulnerabilities: [] };
  input.verificationReport = {
    ...input.verificationReport,
    engine: { method: "static-analysis", name: "slither", version: "0.11.6" },
    verifications: [{
      findingId: "missed-static-1",
      status: "missed",
      method: "static-analysis",
      confidence: 0.9,
      evidence: {
        tool: "slither@0.11.6",
        detector: "incorrect-exp",
        lines: "L117",
        note: "Requires manual triage."
      },
      verifierAgentId: "97:verifier"
    }],
    summary: { confirmed: 0, rejected: 0, partial: 0, inconclusive: 0, missed: 1 }
  };
  const report = buildDueDiligenceReport({
    ...input,
    provenance: {
      audit: "unavailable-timeout",
      findingVerification: "local-unpaid",
      onchainInvestigation: "paid-mission",
      tokenRiskReview: "local-unpaid"
    },
    auditFailureReason: "Timed out",
    now: () => new Date("2026-09-01T00:02:00.000Z")
  });
  assert.equal(report.security.auditorFindings, 0);
  assert.equal(report.security.confirmedCriticalHighFindings, 0);
  assert.equal(report.security.uncoveredDetections[0]?.reviewStatus, "unreviewed");
  assert.match(report.decision.reasons.join(" "), /not confirmed vulnerabilities/);
  assert.match(report.decision.requiredActions.join(" "), /Manually triage/);
});

test("rejects source and review evidence from a different target", () => {
  const input = fixtures();
  assert.throws(() => buildDueDiligenceReport({
    ...input,
    securityInput: { ...input.securityInput, contractAddress: PROXY },
    provenance: {
      audit: "local-unpaid",
      findingVerification: "local-unpaid",
      onchainInvestigation: "paid-mission",
      tokenRiskReview: "local-unpaid"
    },
    now: () => new Date()
  }), /does not match the onchain implementation/);

  assert.throws(() => buildDueDiligenceReport({
    ...input,
    tokenRiskReview: { ...input.tokenRiskReview, blockNumber: 124 },
    provenance: {
      audit: "local-unpaid",
      findingVerification: "local-unpaid",
      onchainInvestigation: "paid-mission",
      tokenRiskReview: "local-unpaid"
    },
    now: () => new Date()
  }), /not bound to the onchain investigation/);
});
