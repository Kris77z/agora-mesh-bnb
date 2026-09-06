import { decodeFunctionData, decodeEventLog, parseAbi, type Hex } from "viem";
import { witnessHash } from "@altananetwork/x402-server";
import { calculateX402RequestHash, calculateX402IdempotencyKey, sameAddress, type X402ExecutionRequest } from "@rebel/shared";

export const PERMIT2_SETTLEMENT_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const SETTLEMENT_ABI = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct Permit { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct TransferDetails { address to; uint256 requestedAmount; }",
  "function permitWitnessTransferFrom(Permit permit, TransferDetails transferDetails, address owner, bytes32 witness, string witnessTypeString, bytes signature)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);
export const WITNESS_TYPE_STRING = "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

/** Never attach an arbitrary same-amount Transfer to a task: prove the signed nonce and calldata too. */
export function verifySettlementProof(input: {
  request: X402ExecutionRequest; chainId: number; payer: string; recipient: string; facilitator: string;
  transaction: { hash: Hex; to: string | null; from: string; input: Hex };
  receipt: { transactionHash: Hex; status: string; logs: Array<{ address: string; data: Hex; topics: readonly Hex[] }> };
}): "permit2-witness" | "eip3009" {
  const { request, transaction: tx, receipt } = input;
  const expectedHash = calculateX402RequestHash({
    missionId: request.missionId, chainId: input.chainId, serviceId: request.serviceId, offerVersion: request.offerVersion,
    taskType: request.taskType, taskInput: request.taskInput, timestamp: request.timestamp, expiresAt: request.expiresAt,
    paymentNonce: request.paymentNonce, assetAddress: request.asset, amount: request.amount,
    providerAddress: input.recipient, resourcePath: "/execute/x402"
  });
  if (request.requestHash !== expectedHash || request.idempotencyKey !== calculateX402IdempotencyKey({
    missionId: request.missionId, serviceId: request.serviceId, requestHash: expectedHash
  })) throw new Error("Original request binding is invalid");
  if (receipt.status !== "success" || tx.hash !== receipt.transactionHash || !sameAddress(tx.from, input.facilitator)) {
    throw new Error("Settlement transaction is not a confirmed payment by this facilitator");
  }
  const call = decodeFunctionData({ abi: SETTLEMENT_ABI, data: tx.input });
  let rail: "permit2-witness" | "eip3009";
  if (call.functionName === "permitWitnessTransferFrom") {
    const [permit, details, owner, witness, typeString] = call.args;
    if (!tx.to || !sameAddress(tx.to, PERMIT2_SETTLEMENT_ADDRESS) || !sameAddress(owner, input.payer) ||
        !sameAddress(permit.permitted.token, request.asset) || permit.permitted.amount !== BigInt(request.amount) ||
        permit.nonce !== BigInt(request.requestHash) || permit.deadline !== BigInt(request.expiresAt) ||
        !sameAddress(details.to, input.recipient) || details.requestedAmount !== BigInt(request.amount) ||
        witness !== witnessHash(input.recipient as Hex, 0n) || typeString !== WITNESS_TYPE_STRING) {
      throw new Error("Permit2 calldata does not prove this exact request");
    }
    rail = "permit2-witness";
  } else {
    const [from, to, value, validAfter, validBefore, nonce] = call.args;
    if (!tx.to || !sameAddress(tx.to, request.asset) || !sameAddress(from, input.payer) ||
        !sameAddress(to, input.recipient) || value !== BigInt(request.amount) || validAfter !== 0n ||
        validBefore !== BigInt(request.expiresAt) || nonce.toLowerCase() !== request.requestHash.toLowerCase()) {
      throw new Error("EIP-3009 calldata does not prove this exact request");
    }
    rail = "eip3009";
  }
  const transfers = receipt.logs.filter((log) => sameAddress(log.address, request.asset)).flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: SETTLEMENT_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return event.eventName === "Transfer" && sameAddress(event.args.from, input.payer) &&
        sameAddress(event.args.to, input.recipient) && event.args.value === BigInt(request.amount) ? [event] : [];
    } catch { return []; }
  });
  if (transfers.length !== 1) throw new Error("Expected unique token transfer is absent or ambiguous");
  return rail;
}
