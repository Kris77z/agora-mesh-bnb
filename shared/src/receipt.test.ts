import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { calculateResultHash, receiptSigningMessage, verifyReceiptSignature } from "./utils.js";
import type { Receipt } from "./types.js";

test("v2 signatures bind request, result, provider and timestamp; legacy receipts remain readable", async () => {
  const wallet = ethers.Wallet.createRandom();
  const unsigned = { signatureScheme: "agora-request-result-v2" as const, requestHash: `0x${"11".repeat(32)}`,
    resultHash: calculateResultHash("audit"), provider: wallet.address, timestamp: 1000 };
  const receipt = { ...unsigned, signature: await wallet.signMessage(receiptSigningMessage(unsigned)) };
  assert.equal(verifyReceiptSignature(receipt), true);
  for (const changed of [{ requestHash: `0x${"22".repeat(32)}` }, { timestamp: 1001 }, { resultHash: calculateResultHash("tampered") }]) {
    assert.equal(verifyReceiptSignature({ ...receipt, ...changed }), false);
  }
  const legacy: Receipt = { ...unsigned, signatureScheme: undefined, signature: await wallet.signMessage(unsigned.resultHash) };
  assert.equal(verifyReceiptSignature(legacy), true);
  assert.equal(verifyReceiptSignature({ ...receipt, signatureScheme: undefined }), false);
});
