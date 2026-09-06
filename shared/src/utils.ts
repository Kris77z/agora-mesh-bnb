import { ethers } from "ethers";
import type { Receipt } from "./types.js";

export function buildCaip2Network(chainId: number): string {
  return `eip155:${chainId}`;
}

export function calculateRequestHash(input: {
  taskType: string;
  taskInput: string;
  timestamp: number;
  providerAddress: string;
}): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["string", "string", "uint256", "address"],
      [input.taskType, input.taskInput, BigInt(input.timestamp), input.providerAddress]
    )
  );
}

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function calculateResultHash(result: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(result));
}

export function isHexTxHash(txHash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(txHash);
}

export function sameAddress(a: string, b: string): boolean {
  return ethers.getAddress(a) === ethers.getAddress(b);
}

export function verifyReceiptSignature(receipt: Receipt): boolean {
  const recovered = ethers.verifyMessage(receiptSigningMessage(receipt), receipt.signature);
  return sameAddress(recovered, receipt.provider);
}

export function receiptSigningMessage(receipt: Omit<Receipt, "signature">): string {
  // Historical receipts remain verifiable, but new receipts bind the request as well as the result.
  if (receipt.signatureScheme === undefined) return receipt.resultHash;
  if (receipt.signatureScheme !== "agora-request-result-v2") throw new Error("Unsupported receipt signature scheme");
  if (!Number.isSafeInteger(receipt.timestamp) || receipt.timestamp <= 0) throw new Error("Invalid receipt timestamp");
  return ethers.solidityPackedKeccak256(
    ["string", "bytes32", "bytes32", "address", "uint256"],
    ["agora-mesh:receipt:v2", receipt.requestHash, receipt.resultHash, receipt.provider, receipt.timestamp]
  );
}
