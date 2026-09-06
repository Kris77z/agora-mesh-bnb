import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { calculateResultHash, type Receipt } from "@rebel/shared";
import { verifyReceiptTool } from "./verify.js";

async function signedReceipt(result: string): Promise<{ receipt: Receipt; provider: string }> {
  const wallet = ethers.Wallet.createRandom();
  const resultHash = calculateResultHash(result);
  return {
    provider: wallet.address,
    receipt: {
      requestHash: "0xrequest",
      resultHash,
      provider: wallet.address,
      timestamp: 1,
      signature: await wallet.signMessage(resultHash)
    }
  };
}

test("binds a valid receipt to both delivered result and selected provider", async () => {
  const signed = await signedReceipt("delivered result");
  assert.equal(
    verifyReceiptTool(signed.receipt, {
      result: "delivered result",
      provider: signed.provider
    }).isValid,
    true
  );
  assert.equal(
    verifyReceiptTool(signed.receipt, {
      result: "tampered result",
      provider: signed.provider
    }).isValid,
    false
  );
  assert.equal(
    verifyReceiptTool(signed.receipt, {
      result: "delivered result",
      provider: ethers.Wallet.createRandom().address
    }).isValid,
    false
  );
});
