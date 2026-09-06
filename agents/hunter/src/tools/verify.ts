import {
  calculateResultHash,
  sameAddress,
  verifyReceiptSignature,
  type Receipt
} from "@rebel/shared";

export function verifyReceiptTool(
  receipt: Receipt,
  expected?: { result?: string; provider?: string }
): {
  isValid: boolean;
  provider: string;
  signatureValid: boolean;
  resultHashMatches: boolean;
  providerMatches: boolean;
} {
  let signatureValid = false;
  let providerMatches = expected?.provider === undefined;
  try {
    signatureValid = verifyReceiptSignature(receipt);
    providerMatches =
      expected?.provider === undefined || sameAddress(receipt.provider, expected.provider);
  } catch {
    signatureValid = false;
    providerMatches = false;
  }
  const resultHashMatches =
    expected?.result === undefined || calculateResultHash(expected.result) === receipt.resultHash;
  return {
    isValid: signatureValid && resultHashMatches && providerMatches,
    provider: receipt.provider,
    signatureValid,
    resultHashMatches,
    providerMatches
  };
}

export function evaluateResultTool(result: string): {
  score: number;
  summary: string;
} {
  const length = result.trim().length;
  if (length > 600) {
    return { score: 9, summary: "Detailed and high-signal output." };
  }
  if (length > 200) {
    return { score: 7, summary: "Reasonable detail for MVP task." };
  }
  return { score: 5, summary: "Result is short; could be expanded." };
}
