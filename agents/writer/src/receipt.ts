import { ethers } from "ethers";
import { calculateResultHash, nowInSeconds, receiptSigningMessage, type Receipt } from "@rebel/shared";
import { writerConfig } from "./config.js";
import { WriterError } from "./errors.js";

function getReceiptSigner(): ethers.Wallet {
  if (!writerConfig.writerPrivateKey) {
    throw new WriterError(
      500,
      "SIGNER_UNAVAILABLE",
      "WRITER_PRIVATE_KEY is required to sign a receipt"
    );
  }
  return new ethers.Wallet(writerConfig.writerPrivateKey);
}

export async function createReceipt(input: {
  requestHash: string;
  result: string;
}): Promise<Receipt> {
  const signer = getReceiptSigner();
  const resultHash = calculateResultHash(input.result);
  const unsigned: Omit<Receipt, "signature"> = {
    signatureScheme: "agora-request-result-v2",
    requestHash: input.requestHash,
    resultHash,
    provider: writerConfig.writerAddress,
    timestamp: nowInSeconds()
  };
  return { ...unsigned, signature: await signer.signMessage(receiptSigningMessage(unsigned)) };
}
