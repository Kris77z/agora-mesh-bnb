import assert from "node:assert/strict";
import { ethers } from "ethers";
import { calculateResultHash, calculateX402RequestHash, calculateX402IdempotencyKey, receiptSigningMessage } from "@rebel/shared";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverMissionFromEvidence } from "./mission-recovery.js";

const ASSET = {
  chainId: 97,
  kind: "erc20" as const,
  address: "0x2222222222222222222222222222222222222222" as const,
  symbol: "U",
  decimals: 18
};

async function executionRecord(input: {
  serviceId: string;
  missionId?: string;
  timestamp: number;
  amount: string;
  txByte: string;
  recipient: `0x${string}`;
  result: string;
}) {
  const signer = new ethers.Wallet(`0x${input.txByte.repeat(32)}`);
  const unsignedRequest = {
    missionId: input.missionId ?? "mission-recovered", chainId: 97, serviceId: input.serviceId,
    offerVersion: "1", taskType: input.serviceId === "verifier-v1" ? "finding-verification" : "smart-contract-audit",
    taskInput: JSON.stringify({ source: "contract Test {}", sourceHash: "sha256:test" }),
    timestamp: input.timestamp, expiresAt: input.timestamp + 60, paymentNonce: `0x${input.txByte.repeat(32)}` as `0x${string}`,
    assetAddress: ASSET.address, amount: input.amount, providerAddress: signer.address, resourcePath: "/execute/x402"
  };
  const requestHash = calculateX402RequestHash(unsignedRequest);
  const idempotencyKey = calculateX402IdempotencyKey({ ...unsignedRequest, requestHash });
  const request = { ...unsignedRequest, asset: ASSET.address, requestHash, idempotencyKey };
  const unsignedReceipt = {
    requestHash, resultHash: calculateResultHash(input.result), provider: signer.address, timestamp: input.timestamp,
    signatureScheme: "agora-request-result-v2" as const
  };
  const transaction = `0x${input.txByte.repeat(32)}`;
  const payment = {
    status: "payment-completed",
    rail: "x402",
    transaction,
    network: "eip155:97",
    payer: "0x1111111111111111111111111111111111111111",
    recipient: signer.address,
    amount: { asset: ASSET, amount: input.amount },
    transferMethod: "permit2-witness"
  };
  return {
    serviceId: input.serviceId,
    request, requestHash, idempotencyKey,
    updatedAt: input.timestamp,
    payment,
    response: {
      result: input.result,
      receipt: { ...unsignedReceipt, signature: await signer.signMessage(receiptSigningMessage(unsignedReceipt)) },
      payment, requestHash, idempotencyKey,
      cached: false
    }
  };
}

test("recovers a pre-persistence audit only from exact mission-bound, signed receipt evidence", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-mission-recovery-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "receipts.json");
  const missionId = "mission-recovered";
  const auditor = await executionRecord({
    serviceId: "auditor-v1",
    timestamp: 1_000,
    amount: "500",
    txByte: "11",
    recipient: "0x3333333333333333333333333333333333333333",
    result: JSON.stringify({ vulnerabilities: [] })
  });
  const verifier = await executionRecord({
    serviceId: "verifier-v1",
    timestamp: 1_005,
    amount: "250",
    txByte: "22",
    recipient: "0x4444444444444444444444444444444444444444",
    result: JSON.stringify({
      sourceName: "Contract.sol",
      sourceHash: "sha256:test",
      engine: { method: "static-analysis", name: "slither", version: "0.11.6" },
      verifications: [],
      summary: { confirmed: 0, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
    })
  });
  await writeFile(storePath, JSON.stringify({
    version: 1,
    records: { auditor, verifier }
  }), "utf8");

  const mission = await recoverMissionFromEvidence({
    missionId,
    chainId: 97,
    receiptStorePaths: [storePath],
    experiences: [{
      missionId,
      goal: "Audit this source",
      serviceUsed: "auditor-v1",
      taskType: "smart-contract-audit",
      score: 9,
      lesson: "High signal",
      timestamp: 1_010
    }]
  });

  assert.equal(mission?.source, "recovered-evidence");
  assert.equal(mission?.result?.paymentTx, auditor.payment.transaction);
  assert.equal(mission?.result?.verification?.paymentTx, verifier.payment.transaction);
  assert.equal(mission?.result?.verification?.report.engine.name, "slither");
  assert.equal(mission?.events.filter((event) => event.type === "payment_confirmed").length, 2);
  await writeFile(storePath, JSON.stringify({ version: 1, records: { auditor } }), "utf8");
  assert.equal(await recoverMissionFromEvidence({
    missionId, chainId: 97, receiptStorePaths: [storePath], experiences: [{
      missionId, goal: "Audit this source", serviceUsed: "auditor-v1", taskType: "smart-contract-audit",
      score: 9, lesson: "High signal", timestamp: 1_010
    }]
  }), undefined, "Missing independent verifier must not become a completed audit pipeline");
});

test("does not borrow adjacent mission receipts or trust tampered delivery evidence", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-mission-binding-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "receipts.json");
  const record = await executionRecord({
    serviceId: "auditor-v1", missionId: "other-mission", timestamp: 1000, amount: "500", txByte: "11",
    recipient: "0x3333333333333333333333333333333333333333", result: '{"vulnerabilities":[]}'
  });
  const input = {
    missionId: "wanted-mission", chainId: 97, receiptStorePaths: [file],
    experiences: [{ missionId: "wanted-mission", goal: "Audit", serviceUsed: "auditor-v1", taskType: "smart-contract-audit", score: 9, lesson: "ok", timestamp: 1000 }]
  };
  await writeFile(file, JSON.stringify({ version: 1, records: { record } }));
  assert.equal(await recoverMissionFromEvidence(input), undefined);
  const bound = await executionRecord({
    serviceId: "auditor-v1", missionId: input.missionId, timestamp: 1000, amount: "500", txByte: "11",
    recipient: "0x3333333333333333333333333333333333333333", result: '{"vulnerabilities":[]}'
  });
  bound.response.result = '{"vulnerabilities":["forged"]}';
  await writeFile(file, JSON.stringify({ version: 1, records: { bound } }));
  assert.equal(await recoverMissionFromEvidence(input), undefined);
});
