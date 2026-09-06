import assert from "node:assert/strict";
import test from "node:test";
import { validateStructuredSkillOutput } from "./structured-output.js";

test("accepts the evidence-rich auditor finding schema", () => {
  const report = {
    vulnerabilities: [
      {
        findingId: "tx-origin-auth",
        title: "tx.origin authorization",
        severity: "high",
        description: "Authorization depends on tx.origin.",
        evidence: { file: "Vault.sol", lines: "L12", snippet: "require(tx.origin == owner);" },
        exploitScenario: "A malicious intermediary tricks the owner into calling it.",
        recommendation: "Use msg.sender and explicit roles.",
        confidence: 0.98
      }
    ]
  };
  assert.deepEqual(validateStructuredSkillOutput("audit-vulnerabilities-v1", report), report);
});

test("rejects legacy auditor output without structured evidence", () => {
  assert.throws(() =>
    validateStructuredSkillOutput("audit-vulnerabilities-v1", {
      vulnerabilities: [
        {
          title: "Reentrancy",
          severity: "high",
          description: "External call before state update",
          evidence: "withdraw()",
          recommendation: "Use CEI"
        }
      ]
    })
  );
});

test("accepts a source-timestamped onchain risk report with explicit coverage gaps", () => {
  const report = {
    version: 1,
    chainId: 97,
    target: {
      address: "0x1111111111111111111111111111111111111111",
      classification: "eoa",
      bytecodeSize: 0
    },
    observedAt: "2026-09-01T07:00:00.000Z",
    blockNumber: 1,
    sources: [{
      kind: "rpc",
      endpoint: "https://rpc.example",
      methods: ["eth_getCode"],
      observedAt: "2026-09-01T07:00:00.000Z"
    }],
    facts: {
      nativeBalanceWei: "0",
      transactionCount: "1",
      ownership: { probe: "unavailable" },
      proxy: { standard: "eip-1967" }
    },
    riskSignals: [],
    riskScore: 0,
    riskLevel: "low",
    coverage: {
      accountState: "measured",
      contractBytecode: "measured",
      tokenMetadata: "not-applicable",
      ownership: "unavailable",
      proxySlots: "measured",
      holderConcentration: "not-measured",
      liquidity: "not-measured",
      recentTransactions: "not-measured"
    },
    limitations: ["Holder concentration is not measured."],
    recommendation: "Collect indexed evidence before a trust decision."
  };
  assert.deepEqual(validateStructuredSkillOutput("onchain-risk-report-v1", report), report);
});
