import assert from "node:assert/strict";
import test from "node:test";
import type { OnchainRiskReport, ServiceInfo } from "@rebel/shared";
import { HunterError } from "./errors.js";
import {
  independentRiskVerifierCandidates,
  independentVerifierCandidates,
  parseAuditReport,
  parseOnchainRiskReport,
  parseTokenRiskVerificationReport,
  tokenRiskReportHash,
  parseVerificationReport
} from "./security-pipeline.js";

const finding = {
  findingId: "tx-origin",
  title: "tx.origin authorization",
  severity: "high" as const,
  description: "Authorization uses tx.origin.",
  evidence: { lines: "L3", snippet: "tx.origin" },
  exploitScenario: "A phishing contract forwards the call.",
  recommendation: "Use msg.sender and explicit roles.",
  confidence: 0.9
};

function service(overrides: Partial<ServiceInfo>): ServiceInfo {
  return {
    id: "service",
    name: "Service",
    description: "test",
    endpoint: "http://localhost:3001",
    price: "1",
    currency: "tBNB",
    network: "eip155:97",
    provider: "0x1111111111111111111111111111111111111111",
    ...overrides
  };
}

const onchainReport: OnchainRiskReport = {
  version: 1,
  chainId: 97,
  target: {
    address: "0x1111111111111111111111111111111111111111",
    classification: "erc20",
    bytecodeSize: 100,
    bytecodeHash: `0x${"1".repeat(64)}`
  },
  observedAt: "2026-09-01T00:00:00.000Z",
  blockNumber: 100,
  sources: [{
    kind: "rpc",
    endpoint: "https://source-rpc.example",
    methods: ["eth_getCode"],
    observedAt: "2026-09-01T00:00:00.000Z"
  }],
  facts: {
    nativeBalanceWei: "0",
    transactionCount: "1",
    token: { name: "Risk", symbol: "RISK", decimals: 18, totalSupply: "1000" },
    ownership: { probe: "unavailable" },
    proxy: { standard: "eip-1967" }
  },
  riskSignals: [],
  riskScore: 0,
  riskLevel: "low",
  coverage: {
    accountState: "measured",
    contractBytecode: "measured",
    tokenMetadata: "measured",
    ownership: "unavailable",
    proxySlots: "measured",
    holderConcentration: "not-measured",
    liquidity: "not-measured",
    recentTransactions: "not-measured"
  },
  limitations: ["Indexed dimensions are not measured."],
  recommendation: "Collect indexed evidence."
};

test("parses strict auditor findings and rejects an empty legacy shape", () => {
  assert.equal(parseAuditReport(JSON.stringify({ vulnerabilities: [finding] })).vulnerabilities.length, 1);
  assert.throws(
    () => parseAuditReport(JSON.stringify({ findings: [] })),
    (error: unknown) => error instanceof HunterError && error.code === "AUDIT_REPORT_INVALID"
  );
});

test("requires verifier output to bind the original source hash", () => {
  const expected = `sha256:${"a".repeat(64)}`;
  const raw = JSON.stringify({
    sourceName: "Vault.sol",
    sourceHash: `sha256:${"b".repeat(64)}`,
    engine: { method: "ast-rule", name: "rules", version: "1" },
    verifications: [],
    summary: { confirmed: 0, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
  });
  assert.throws(
    () => parseVerificationReport(raw, expected),
    (error: unknown) => error instanceof HunterError && error.code === "VERIFICATION_SOURCE_MISMATCH"
  );
});

test("rejects internally inconsistent verification counts", () => {
  const sourceHash = `sha256:${"a".repeat(64)}`;
  const raw = JSON.stringify({
    sourceName: "Vault.sol",
    sourceHash,
    engine: { method: "ast-rule", name: "rules", version: "1" },
    verifications: [
      {
        findingId: finding.findingId,
        status: "confirmed",
        method: "ast-rule",
        confidence: 0.9,
        evidence: { note: "found" },
        verifierAgentId: "verifier"
      }
    ],
    summary: { confirmed: 0, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
  });
  assert.throws(
    () =>
      parseVerificationReport(raw, sourceHash, {
        findingIds: [finding.findingId],
        verifierAgentId: "verifier"
      }),
    (error: unknown) => error instanceof HunterError && error.code === "VERIFICATION_REPORT_INVALID"
  );
});

test("accepts a complete verifier report bound to the expected agent and finding", () => {
  const sourceHash = `sha256:${"c".repeat(64)}`;
  const report = parseVerificationReport(
    JSON.stringify({
      sourceName: "Vault.sol",
      sourceHash,
      engine: { method: "static-analysis", name: "slither", version: "0.11.3" },
      verifications: [
        {
          findingId: finding.findingId,
          status: "confirmed",
          method: "static-analysis",
          confidence: 0.9,
          evidence: { tool: "slither", detector: "tx-origin", note: "found" },
          verifierAgentId: "verifier-agent"
        }
      ],
      summary: { confirmed: 1, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
    }),
    sourceHash,
    { findingIds: [finding.findingId], verifierAgentId: "verifier-agent" }
  );
  assert.equal(report.summary.confirmed, 1);
});

test("filters verifier candidates that share the auditor id, agent, or wallet", () => {
  const auditor = service({ id: "auditor", agentId: "agent-a" });
  const independent = service({
    id: "verifier",
    agentId: "agent-b",
    taskType: "finding-verification",
    provider: "0x2222222222222222222222222222222222222222"
  });
  const candidates = independentVerifierCandidates(
    [
      auditor,
      service({ id: "same-agent", agentId: "agent-a", taskType: "finding-verification" }),
      service({ id: "same-wallet", agentId: "agent-c", taskType: "finding-verification" }),
      independent
    ],
    auditor
  );
  assert.deepEqual(candidates.map((item) => item.id), ["verifier"]);
});

test("accepts an independent token-risk replay bound to the exact source report", () => {
  assert.equal(parseOnchainRiskReport(JSON.stringify(onchainReport)).blockNumber, 100);
  const raw = JSON.stringify({
    version: 1,
    chainId: 97,
    target: onchainReport.target.address,
    sourceReportHash: tokenRiskReportHash(onchainReport),
    sourceObservedAt: onchainReport.observedAt,
    verifiedAt: "2026-09-01T01:00:00.000Z",
    blockNumber: 100,
    engine: {
      method: "independent-rpc-replay",
      name: "agora-token-risk-verifier",
      version: "1",
      endpoint: "https://independent-rpc.example",
      independentTransport: true
    },
    checks: [{
      id: "target-runtime",
      status: "confirmed",
      expected: "same",
      actual: "same",
      evidence: "replayed"
    }],
    summary: { confirmed: 1, mismatched: 0, unavailable: 0, total: 1 },
    conclusion: {
      status: "confirmed",
      originalRiskScore: 0,
      replayedRiskScore: 0,
      originalRiskLevel: "low",
      replayedRiskLevel: "low"
    },
    limitations: ["Indexed dimensions remain unmeasured."]
  });
  assert.equal(
    parseTokenRiskVerificationReport(raw, onchainReport).conclusion.status,
    "confirmed"
  );
  assert.throws(
    () => parseTokenRiskVerificationReport(
      raw,
      { ...onchainReport, blockNumber: 101 }
    ),
    (error: unknown) =>
      error instanceof HunterError && error.code === "TOKEN_RISK_VERIFICATION_SOURCE_MISMATCH"
  );
});

test("filters token-risk verifiers that share the Investigator identity", () => {
  const investigator = service({ id: "investigator", agentId: "agent-a" });
  const independent = service({
    id: "risk-verifier",
    agentId: "agent-b",
    taskType: "token-risk-verification",
    provider: "0x2222222222222222222222222222222222222222"
  });
  const candidates = independentRiskVerifierCandidates([
    investigator,
    service({ id: "same-agent", agentId: "agent-a", taskType: "token-risk-verification" }),
    service({ id: "same-wallet", agentId: "agent-c", taskType: "token-risk-verification" }),
    independent
  ], investigator);
  assert.deepEqual(candidates.map((item) => item.id), ["risk-verifier"]);
});
