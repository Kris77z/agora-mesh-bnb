import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvantageReport } from "./advantage-report.js";
import type {
  AuditGroundTruthManifest,
  AuditToolBaselineEvidence,
  PaidDueDiligenceEvidence,
  TokenRiskEnrichmentEvidence,
  TokenRiskSecurityReviewEvidence
} from "./advantage-evaluator.js";
import type { StoredHunterMission } from "./mission-store.js";
import { tokenRiskReportHash } from "./security-pipeline.js";
import type { OnchainRiskReport } from "@rebel/shared";

test("reports measured agent facts while keeping baseline and ground truth pending", () => {
  const mission = {
    missionId: "mission-audit",
    goal: "Audit source",
    chainId: 97,
    mode: "scripted",
    status: "completed",
    source: "live-run",
    events: [],
    createdAt: 1_000,
    completedAt: 27_000,
    result: {
      missionId: "mission-audit",
      goal: "Audit source",
      mode: "scripted",
      service: {
        id: "auditor-v1",
        name: "Auditor",
        description: "Audit",
        endpoint: "",
        taskType: "smart-contract-audit",
        price: "500",
        currency: "U",
        asset: { chainId: 97, kind: "erc20", address: "0x2222222222222222222222222222222222222222", symbol: "U", decimals: 18 },
        network: "eip155:97",
        provider: "0x3333333333333333333333333333333333333333"
      },
      quote: {},
      paymentTx: `0x${"11".repeat(32)}`,
      execution: {
        result: JSON.stringify({ vulnerabilities: [{ severity: "critical" }, { severity: "high" }] }),
        receipt: { requestHash: "a", resultHash: "b", provider: "c", timestamp: 1, signature: "d" },
        payment: { status: "payment-completed", transaction: "tx", network: "eip155:97" }
      },
      receiptVerified: true,
      evaluation: { score: 9, summary: "high signal" },
      finalMessage: "done"
    }
  } as unknown as StoredHunterMission;

  const report = buildAdvantageReport([mission], 100);
  const audit = report.experiments[0];
  assert.equal(audit.agent.status, "measured");
  assert.equal(audit.baseline.status, "pending");
  assert.equal(audit.groundTruth.status, "pending");
  if (audit.agent.status === "measured") {
    assert.equal(audit.agent.kind, "contract-audit");
    assert.equal(audit.agent.durationMs, 26_000);
    assert.equal(audit.agent.auditorCriticalHighFindings, 2);
  }
  assert.equal(report.summary.completedComparisons, 0);
});

test("reports a completed paid onchain investigation without inventing ground truth", () => {
  const mission = {
    missionId: "mission-token-risk",
    goal: "Investigate token",
    chainId: 97,
    mode: "scripted",
    status: "completed",
    source: "live-run",
    events: [],
    createdAt: 1_000,
    completedAt: 61_000,
    result: {
      missionId: "mission-token-risk",
      goal: "Investigate token",
      mode: "scripted",
      service: {
        id: "investigator-v1",
        name: "Investigator",
        endpoint: "",
        taskType: "onchain-investigation",
        price: "350000000000000000",
        currency: "U",
        asset: { chainId: 97, kind: "erc20", address: "0x2222222222222222222222222222222222222222", symbol: "U", decimals: 18 }
      },
      quote: {},
      paymentTx: `0x${"22".repeat(32)}`,
      execution: {
        result: JSON.stringify({
          version: 1,
          chainId: 97,
          target: { address: "0x1111111111111111111111111111111111111111", classification: "erc20", bytecodeSize: 100 },
          observedAt: "2026-09-01T00:00:00Z",
          blockNumber: 123,
          sources: [],
          facts: { nativeBalanceWei: "0", transactionCount: "1", ownership: { probe: "unavailable" }, proxy: { standard: "eip-1967" } },
          riskSignals: [
            { id: "high", severity: "high", title: "High", evidence: "fact", confidence: 0.9 },
            { id: "info", severity: "info", title: "Info", evidence: "fact", confidence: 0.8 }
          ],
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
          limitations: ["No holder index"],
          recommendation: "Review privileges"
        }),
        receipt: { requestHash: "a", resultHash: "b", provider: "c", timestamp: 1, signature: "d" },
        payment: {
          status: "payment-completed",
          transaction: `0x${"22".repeat(32)}`,
          network: "eip155:97",
          amount: {
            asset: { chainId: 97, kind: "erc20", address: "0x2222222222222222222222222222222222222222", symbol: "U", decimals: 18 },
            amount: "350000000000000000"
          }
        }
      },
      receiptVerified: true,
      evaluation: { score: 9, summary: "high signal" },
      finalMessage: "done"
    }
  } as unknown as StoredHunterMission;

  const report = buildAdvantageReport([mission], 100);
  const tokenRisk = report.experiments[1];
  assert.equal(tokenRisk.status, "partial");
  assert.equal(tokenRisk.agent.status, "measured");
  if (tokenRisk.agent.status === "measured") {
    assert.equal(tokenRisk.agent.kind, "token-risk");
    if (tokenRisk.agent.kind === "token-risk") {
      assert.equal(tokenRisk.agent.riskScore, 51);
      assert.equal(tokenRisk.agent.riskSignals, 2);
      assert.equal(tokenRisk.agent.highCriticalSignals, 1);
      assert.deepEqual(tokenRisk.agent.coverage, { measured: 5, total: 8 });
    }
  }
  assert.equal(tokenRisk.groundTruth.status, "pending");
  assert.equal(report.summary.measuredAgentRuns, 1);
  assert.equal(report.summary.completedComparisons, 0);

  const sourceReport = JSON.parse(
    (mission as unknown as StoredHunterMission).result!.execution.result
  ) as OnchainRiskReport;
  const sourceReportHash = tokenRiskReportHash(sourceReport);
  const review: TokenRiskSecurityReviewEvidence = {
    version: 1,
    experimentId: "token-risk",
    reviewKind: "independent-security-agent-rpc-replay",
    settlement: { status: "not-paid", reason: "test" },
    source: {
      missionId: "mission-token-risk",
      evidenceFile: "paid-run-output.json",
      reportHash: sourceReportHash,
      blockNumber: 123
    },
    timing: {
      startedAt: "2026-09-01T00:01:00.000Z",
      completedAt: "2026-09-01T00:01:01.000Z",
      durationMs: 1_000
    },
    reviewer: {
      serviceId: "risk-verifier-v1",
      engine: {
        method: "independent-rpc-replay",
        name: "agora-token-risk-verifier",
        version: "1",
        endpoint: "https://independent.example",
        independentTransport: true
      }
    },
    review: {
      version: 1,
      chainId: 97,
      target: sourceReport.target.address,
      sourceReportHash,
      sourceObservedAt: sourceReport.observedAt,
      verifiedAt: "2026-09-01T00:01:01.000Z",
      blockNumber: 123,
      engine: {
        method: "independent-rpc-replay",
        name: "agora-token-risk-verifier",
        version: "1",
        endpoint: "https://independent.example",
        independentTransport: true
      },
      checks: [{ id: "score", status: "confirmed", expected: "51", actual: "51", evidence: "replayed" }],
      summary: { confirmed: 1, mismatched: 0, unavailable: 0, total: 1 },
      conclusion: {
        status: "confirmed",
        originalRiskScore: 51,
        replayedRiskScore: 51,
        originalRiskLevel: "high",
        replayedRiskLevel: "high"
      },
      limitations: ["Indexed dimensions remain unmeasured."]
    }
  };
  const reviewedReport = buildAdvantageReport([mission], 101, undefined, undefined, review);
  const reviewedTokenRisk = reviewedReport.experiments[1]?.agent;
  assert.equal(reviewedTokenRisk?.status, "measured");
  if (reviewedTokenRisk?.status === "measured" && reviewedTokenRisk.kind === "token-risk") {
    assert.equal(reviewedTokenRisk.securityReview?.source, "post-run-evidence");
    assert.equal(reviewedTokenRisk.securityReview?.paid, false);
    assert.equal(reviewedTokenRisk.securityReview?.summary.confirmed, 1);
  }
  assert.equal(reviewedReport.summary.measuredIndependentReviews, 1);

  const enrichment: TokenRiskEnrichmentEvidence = {
    version: 1,
    experimentId: "token-risk",
    enrichmentKind: "post-run-index-and-dex-enrichment",
    settlement: { status: "not-paid", reason: "test" },
    source: {
      missionId: "mission-token-risk",
      evidenceFile: "paid-run-output.json",
      reportHash: sourceReportHash,
      blockNumber: 123,
      target: sourceReport.target.address
    },
    timing: {
      startedAt: "2026-09-01T00:02:00.000Z",
      completedAt: "2026-09-01T00:02:01.000Z",
      durationMs: 1_000
    },
    dex: {
      version: 1,
      chainId: 97,
      target: sourceReport.target.address,
      blockNumber: 123,
      observedAt: "2026-09-01T00:02:01.000Z",
      engine: {
        name: "agora-token-risk-dex-enrichment",
        version: "1",
        method: "historical-eth-call",
        endpoint: "https://independent.example"
      },
      scope: { venue: "PancakeSwap", versions: ["v2", "v3"], quoteAsset: "WBNB" },
      wrappedNative: "0x2222222222222222222222222222222222222222",
      v2: {
        factory: "0x3333333333333333333333333333333333333333",
        router: "0x4444444444444444444444444444444444444444",
        pair: "0x5555555555555555555555555555555555555555",
        pairExists: true,
        reserveTokenRaw: "20",
        reserveWrappedNativeRaw: "5",
        tokenReservePartsPerBillionOfSupply: "16"
      },
      v3: {
        factory: "0x6666666666666666666666666666666666666666",
        pools: [{
          fee: 500,
          pool: "0x7777777777777777777777777777777777777777",
          exists: true,
          liquidityRaw: "0"
        }]
      },
      quote: {
        status: "quote-only",
        inputTokenRaw: "1000000000000000000",
        outputWrappedNativeRaw: "123",
        path: [sourceReport.target.address, "0x2222222222222222222222222222222222222222"],
        limitation: "not an executed swap"
      },
      coverage: { liquidity: "measured", sellability: "partial" },
      interpretation: "V2 pool found; V3 inactive.",
      limitations: ["Scoped venue"]
    },
    indexedData: {
      holderConcentration: { status: "unavailable", reason: "no full index" },
      recentTransactions: {
        status: "measured",
        observedTransfers: 3,
        blockRange: { from: 100, to: 123 },
        activity: {
          transfers: 3,
          uniqueTransactions: 3,
          mints: 0,
          burns: 0,
          uniqueSenders: 3,
          uniqueRecipients: 3,
          transferredRaw: "9",
          firstBlock: 101,
          lastBlock: 122
        }
      },
      attempts: []
    },
    coverage: {
      originalMeasured: 5,
      postRunMeasured: 7,
      total: 8,
      added: ["liquidity", "recentTransactions"],
      partial: ["sellability-quote"],
      unavailable: ["holderConcentration"]
    },
    limitations: ["Scoped venue", "No holder index"]
  };
  const enrichedReport = buildAdvantageReport(
    [mission],
    102,
    undefined,
    undefined,
    review,
    enrichment
  );
  const enrichedTokenRisk = enrichedReport.experiments[1]?.agent;
  assert.equal(enrichedTokenRisk?.status, "measured");
  if (enrichedTokenRisk?.status === "measured" && enrichedTokenRisk.kind === "token-risk") {
    assert.equal(enrichedTokenRisk.enrichment?.coverage.postRunMeasured, 7);
    assert.equal(enrichedTokenRisk.enrichment?.liquidity.activeV3Pools, 0);
    assert.equal(enrichedTokenRisk.enrichment?.recentTransactions.status, "measured");
  }
  assert.equal(enrichedReport.summary.measuredEnrichments, 1);

  const newerUnenrichedMission = structuredClone(mission) as StoredHunterMission;
  newerUnenrichedMission.missionId = "newer-token-risk";
  newerUnenrichedMission.createdAt = 200_000;
  newerUnenrichedMission.completedAt = 260_000;
  const preferredEvidenceReport = buildAdvantageReport(
    [newerUnenrichedMission, mission],
    103,
    undefined,
    undefined,
    review,
    enrichment
  );
  const preferredTokenRisk = preferredEvidenceReport.experiments[1]?.agent;
  assert.equal(preferredEvidenceReport.summary.measuredEnrichments, 1);
  if (preferredTokenRisk?.status === "measured" && preferredTokenRisk.kind === "token-risk") {
    assert.equal(preferredTokenRisk.missionId, "mission-token-risk");
    assert.equal(preferredTokenRisk.enrichment?.coverage.postRunMeasured, 7);
  }
});

test("reports a source-bound tool reference without claiming a controlled comparison", () => {
  const groundTruth: AuditGroundTruthManifest = {
    version: 1,
    benchmarkId: "vault-v1",
    reviewStatus: "reviewed",
    sourceHash: "sha256:source",
    findings: [{
      id: "truth-1",
      category: "reentrancy",
      severity: "high",
      lines: "1",
      matchingFindingIds: ["reentrancy-eth"],
      rationale: "test"
    }]
  };
  const quality = {
    benchmarkId: "vault-v1",
    groundTruthSourceHash: "sha256:source",
    groundTruthFindings: 1,
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
    precision: 1,
    recall: 1,
    evidenceCompleteness: 1,
    matchedGroundTruthIds: ["truth-1"],
    missedGroundTruthIds: []
  };
  const toolBaseline: AuditToolBaselineEvidence = {
    version: 1,
    experimentId: "contract-audit",
    baselineKind: "tool-only-static-analysis",
    controlledHumanBaselineStatus: "pending",
    input: {
      sourceFile: "Contract.sol",
      sourceHash: "sha256:source",
      benchmarkId: "vault-v1"
    },
    runtime: { tool: "Slither", version: "0.11.6", command: "slither" },
    timing: { startedAt: "a", completedAt: "b", durationMs: 975 },
    cost: { currency: "USD", amount: 0, basis: "local" },
    output: {
      ok: true,
      available: true,
      detections: [{ id: "reentrancy-eth" }]
    },
    quality,
    limitations: ["Not a human baseline"]
  };

  const report = buildAdvantageReport([], 100, groundTruth, toolBaseline);
  assert.equal(report.experiments[0]?.toolReference?.status, "measured");
  assert.equal(report.experiments[0]?.toolReference?.quality.recall, 1);
  assert.equal(report.experiments[0]?.baseline.status, "pending");
  assert.equal(report.summary.measuredToolReferences, 1);
  assert.equal(report.summary.completedComparisons, 0);
});

test("exposes model-only candidates without completing controlled comparisons", () => {
  const modelCandidates = [
    {
      status: "model-only-candidate" as const,
      experimentId: "contract-audit" as const,
      kind: "contract-audit" as const,
      model: { provider: "kimi", model: "candidate" },
      durationMs: 10,
      totalTokens: 100,
      controlledBaseline: false as const,
      independentHuman: false as const,
      costUsd: null,
      limitations: ["not controlled"],
      outcome: {
        findings: 3,
        truePositives: 3,
        falsePositives: 0,
        falseNegatives: 0,
        severityAccuracy: 0.3333
      }
    },
    {
      status: "model-only-candidate" as const,
      experimentId: "token-risk" as const,
      kind: "token-risk" as const,
      model: { provider: "kimi", model: "candidate" },
      durationMs: 20,
      totalTokens: 200,
      controlledBaseline: false as const,
      independentHuman: false as const,
      costUsd: null,
      limitations: ["not controlled"],
      outcome: {
        rpcDurationMs: 9,
        modelDurationMs: 11,
        riskSignals: 5,
        recommendation: "high risk"
      }
    },
    {
      status: "model-only-candidate" as const,
      experimentId: "full-due-diligence" as const,
      kind: "due-diligence" as const,
      model: { provider: "kimi", model: "candidate" },
      durationMs: 30,
      totalTokens: 300,
      controlledBaseline: false as const,
      independentHuman: false as const,
      costUsd: null,
      limitations: ["not controlled"],
      outcome: {
        slitherDurationMs: 3,
        rawSlitherDetections: 24,
        trustDecision: "do-not-trust",
        postFreezeCorrections: 3
      }
    }
  ];
  const report = buildAdvantageReport(
    [],
    100,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    modelCandidates
  );
  assert.equal(report.summary.measuredModelCandidates, 3);
  assert.equal(report.summary.completedComparisons, 0);
  assert.equal(report.experiments[0]?.modelCandidate?.controlledBaseline, false);
  assert.equal(report.experiments[1]?.modelCandidate?.kind, "token-risk");
  assert.equal(report.experiments[2]?.modelCandidate?.kind, "due-diligence");
  assert.equal(report.experiments[2]?.baseline.status, "pending");
});

test("reports reconciled paid due diligence only when both paid missions and four tx bindings match", () => {
  const target = "0x1111111111111111111111111111111111111111";
  const asset = { chainId: 97, kind: "erc20", address: target, symbol: "U", decimals: 18 } as const;
  const auditMission = {
    missionId: "paid-audit",
    chainId: 97,
    status: "completed",
    createdAt: 1_000,
    completedAt: 10_000,
    result: {
      service: { taskType: "smart-contract-audit" },
      paymentTx: `0x${"01".repeat(32)}`,
      execution: {
        result: JSON.stringify({ vulnerabilities: [{ severity: "high" }] }),
        payment: { amount: { asset, amount: "500000000000000000" } }
      },
      verification: {
        paymentTx: `0x${"02".repeat(32)}`,
        report: {
          engine: { method: "static-analysis", name: "slither", version: "0.11.6" },
          verifications: [],
          summary: { confirmed: 1, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
        }
      },
      evaluation: { score: 9 }
    }
  } as unknown as StoredHunterMission;
  const onchainReport: OnchainRiskReport = {
    version: 1,
    chainId: 97,
    target: { address: target, classification: "erc20", bytecodeSize: 100 },
    observedAt: "2026-09-01T00:00:00.000Z",
    blockNumber: 123,
    sources: [],
    facts: {
      nativeBalanceWei: "0",
      transactionCount: "1",
      token: { name: "Token", symbol: "U", decimals: 18, totalSupply: "1000" },
      ownership: { probe: "unavailable" },
      proxy: { standard: "eip-1967", implementation: "0x2222222222222222222222222222222222222222", admin: "0x3333333333333333333333333333333333333333" }
    },
    riskSignals: [{ id: "owner", severity: "high", title: "Owner", evidence: "owner active", confidence: 0.9 }],
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
    limitations: ["test"],
    recommendation: "caution"
  };
  const investigationMission = {
    missionId: "paid-investigation",
    chainId: 97,
    status: "completed",
    createdAt: 11_000,
    completedAt: 20_000,
    result: {
      service: { taskType: "onchain-investigation" },
      paymentTx: `0x${"03".repeat(32)}`,
      execution: {
        result: JSON.stringify(onchainReport),
        payment: { amount: { asset, amount: "350000000000000000" } }
      },
      riskReview: {
        service: { id: "risk-verifier-v1" },
        paymentTx: `0x${"04".repeat(32)}`,
        report: {
          target,
          sourceReportHash: tokenRiskReportHash(onchainReport),
          engine: { method: "independent-rpc-replay", name: "risk-verifier", version: "1", endpoint: "https://rpc.example", independentTransport: true },
          conclusion: { status: "confirmed" },
          summary: { confirmed: 11, mismatched: 0, unavailable: 0, total: 11 }
        }
      },
      evaluation: { score: 9 }
    }
  } as unknown as StoredHunterMission;
  const paid: PaidDueDiligenceEvidence = {
    version: 1,
    experimentId: "full-due-diligence",
    status: "completed-after-reconciliation",
    target: { chainId: 97, address: target },
    completedServices: [
      { serviceId: "auditor-v1", amountRaw: "500000000000000000", transaction: `0x${"01".repeat(32)}` },
      { serviceId: "verifier-v1", amountRaw: "250000000000000000", transaction: `0x${"02".repeat(32)}` },
      { serviceId: "investigator-v1", amountRaw: "350000000000000000", transaction: `0x${"03".repeat(32)}` },
      { serviceId: "risk-verifier-v1", amountRaw: "250000000000000000", transaction: `0x${"04".repeat(32)}` }
    ],
    reconciliation: {
      orphanedAuditorSettlementRaw: "500000000000000000",
      orphanedAuditorSettlementTx: `0x${"05".repeat(32)}`,
      refundRaw: "500000000000000000",
      refundTx: `0x${"06".repeat(32)}`,
      grossProviderTransfersRaw: "1850000000000000000",
      netProviderSpendRaw: "1350000000000000000",
      intendedNetSpendRaw: "1350000000000000000",
      balanced: true
    },
    missions: { auditAndFindingVerification: "paid-audit", investigationAndRiskVerification: "paid-investigation" },
    authorityCleanup: {
      originalAuthorityRevoked: true,
      supplementAuthorityRevoked: true,
      finalPermit2AllowanceRaw: "0",
      allSessionMaterialDeleted: true,
      postRevokeNegativeTestsRejected: true
    }
  };
  const report = buildAdvantageReport(
    [auditMission, investigationMission],
    100,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    paid
  );
  const experiment = report.experiments[2];
  assert.equal(experiment?.status, "completed");
  assert.equal(experiment?.agent.status, "measured");
  if (experiment?.agent.status === "measured" && experiment.agent.kind === "due-diligence") {
    assert.equal(experiment.agent.cost.amount, "1350000000000000000");
    assert.equal(experiment.agent.payments.length, 4);
    assert.equal(experiment.agent.authorityCleanup.finalPermit2AllowanceRaw, "0");
    assert.equal(experiment.agent.decision.status, "high-caution");
  }
  assert.equal(report.summary.measuredAgentRuns, 3);
  assert.equal(report.summary.measuredIndependentReviews, 2);
  assert.equal(report.summary.completedComparisons, 0);
});
