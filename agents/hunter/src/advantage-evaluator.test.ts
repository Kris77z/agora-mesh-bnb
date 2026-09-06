import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreAuditAgainstGroundTruth,
  type AuditGroundTruthManifest
} from "./advantage-evaluator.js";

const reviewed: AuditGroundTruthManifest = {
  version: 1,
  benchmarkId: "vault-v1",
  reviewStatus: "reviewed",
  sourceHash: "sha256:source",
  acceptedLegacyInputHashes: ["sha256:legacy"],
  findings: [
    {
      id: "truth-reentrancy",
      category: "reentrancy",
      severity: "critical",
      lines: "15-20",
      matchingFindingIds: ["auditor-reentrancy"],
      rationale: "external call before state update"
    },
    {
      id: "truth-delegatecall",
      category: "delegatecall",
      severity: "high",
      lines: "23-26",
      matchingFindingIds: ["auditor-delegatecall"],
      rationale: "foreign code executes in vault context"
    }
  ]
};

test("scores only reviewed, source-bound ground truth", () => {
  const result = JSON.stringify({
    vulnerabilities: [
      {
        findingId: "auditor-reentrancy",
        evidence: { file: "Contract.sol", lines: "15-20", snippet: "call before update" }
      },
      { findingId: "unknown", evidence: { file: "Contract.sol", lines: "1", snippet: "x" } }
    ]
  });
  const score = scoreAuditAgainstGroundTruth({
    result,
    sourceHash: "sha256:legacy",
    groundTruth: reviewed
  });
  assert.deepEqual(score && {
    truePositives: score.truePositives,
    falsePositives: score.falsePositives,
    falseNegatives: score.falseNegatives,
    precision: score.precision,
    recall: score.recall,
    evidenceCompleteness: score.evidenceCompleteness
  }, {
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.5,
    recall: 0.5,
    evidenceCompleteness: 1
  });
  assert.equal(scoreAuditAgainstGroundTruth({
    result,
    sourceHash: "sha256:other",
    groundTruth: reviewed
  }), undefined);
  assert.equal(scoreAuditAgainstGroundTruth({
    result,
    sourceHash: "sha256:source",
    groundTruth: { ...reviewed, reviewStatus: "candidate" }
  }), undefined);
});
