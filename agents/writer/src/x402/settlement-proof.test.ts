import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { witnessHash } from "@altananetwork/x402-server";
import { calculateX402RequestHash, calculateX402IdempotencyKey, type X402ExecutionRequest } from "@rebel/shared";
import { validateRequestPayment } from "./payment-binding.js";
import { PERMIT2_SETTLEMENT_ADDRESS, SETTLEMENT_ABI, WITNESS_TYPE_STRING, verifySettlementProof } from "./settlement-proof.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const FACILITATOR = "0x4444444444444444444444444444444444444444";
const TX = `0x${"ab".repeat(32)}` as Hex;
function fixture() {
  const request: X402ExecutionRequest = {
    missionId: "proof", serviceId: "auditor-v1", offerVersion: "2", taskType: "smart-contract-audit", taskInput: "source",
    timestamp: 1_900_000_000, expiresAt: 1_900_000_060, paymentNonce: `0x${"11".repeat(32)}`, asset: TOKEN, amount: "20",
    requestHash: "0x", idempotencyKey: "0x"
  };
  request.requestHash = calculateX402RequestHash({ ...request, chainId: 97, assetAddress: TOKEN, providerAddress: SELLER, resourcePath: "/execute/x402" });
  request.idempotencyKey = calculateX402IdempotencyKey({ ...request });
  const permit = { permitted: { token: TOKEN as Hex, amount: 20n }, nonce: BigInt(request.requestHash), deadline: BigInt(request.expiresAt) };
  const data = (nonce = permit.nonce) => encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: "permitWitnessTransferFrom", args: [
    { ...permit, nonce }, { to: SELLER, requestedAmount: 20n }, PAYER, witnessHash(SELLER, 0n), WITNESS_TYPE_STRING, "0x11"
  ] });
  const proof = {
    request, chainId: 97, payer: PAYER, recipient: SELLER, facilitator: FACILITATOR,
    transaction: { hash: TX, from: FACILITATOR, to: PERMIT2_SETTLEMENT_ADDRESS, input: data() },
    receipt: { transactionHash: TX, status: "success", logs: [{ address: TOKEN,
      data: encodeAbiParameters([{ type: "uint256" }], [20n]),
      topics: encodeEventTopics({ abi: SETTLEMENT_ABI, eventName: "Transfer", args: { from: PAYER, to: SELLER } }) as Hex[]
    }] }
  };
  const header = (nonce = permit.nonce, amount = "20") => Buffer.from(JSON.stringify({
    x402Version: 2, network: "eip155:97", accepted: { asset: TOKEN },
    payload: { signature: "0x11", from: PAYER, permit: {
      permitted: { token: TOKEN, amount }, spender: FACILITATOR,
      nonce: nonce.toString(), deadline: String(request.expiresAt), witness: { to: SELLER, validAfter: "0" }
    } }
  })).toString("base64");
  return { request, data, proof, header, runtime: { chainId: 97, payTo: SELLER, facilitatorAddress: FACILITATOR } };
}
test("signed payment binds the exact request hash and rejects overpayment before broadcasting", () => {
  const f = fixture();
  assert.doesNotThrow(() => validateRequestPayment(f.header(), f.request, f.runtime));
  assert.throws(() => validateRequestPayment(f.header(123n), f.request, f.runtime), /exact request hash/);
  assert.throws(() => validateRequestPayment(f.header(BigInt(f.request.requestHash), "21"), f.request, f.runtime), /exact request hash/);
  assert.throws(() => validateRequestPayment(f.header(), { ...f.request, expiresAt: f.request.expiresAt + 1 }, f.runtime), /exact request hash/);
});
test("reconciliation requires both exact signed calldata and a successful unique token Transfer", () => {
  const f = fixture();
  assert.equal(verifySettlementProof(f.proof), "permit2-witness");
  assert.throws(() => verifySettlementProof({ ...f.proof, transaction: { ...f.proof.transaction, input: f.data(123n) } }), /exact request/);
  assert.throws(() => verifySettlementProof({ ...f.proof, receipt: { ...f.proof.receipt, status: "reverted" } }), /confirmed payment/);
  assert.throws(() => verifySettlementProof({ ...f.proof, receipt: { ...f.proof.receipt, logs: [] } }), /absent or ambiguous/);
  assert.throws(() => verifySettlementProof({ ...f.proof, request: { ...f.request, taskInput: "other source" } }), /binding is invalid/);
  assert.throws(() => verifySettlementProof({ ...f.proof, payer: SELLER }), /exact request/);
});
test("EIP-3009 reconciliation also checks the request nonce and exact validity window", () => {
  const f = fixture();
  const input = encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: "transferWithAuthorization", args: [
    PAYER, SELLER, 20n, 0n, BigInt(f.request.expiresAt), f.request.requestHash, "0x11"
  ] });
  assert.equal(verifySettlementProof({ ...f.proof, transaction: { ...f.proof.transaction, to: TOKEN, input } }), "eip3009");
});
