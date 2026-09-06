import { decodeXPayment } from "@altananetwork/x402-server";
import { sameAddress, type X402ExecutionRequest } from "@rebel/shared";
import { WriterError } from "../errors.js";

/** The signed onchain nonce is the request hash; paymentNonce in the body is its random salt. */
export function validateRequestPayment(header: string, request: X402ExecutionRequest, runtime: {
  chainId: number; payTo: string; facilitatorAddress: string
}): void {
  try {
    const payment = decodeXPayment(header);
    if (payment.chainId !== runtime.chainId || payment.amount.toString() !== request.amount ||
        !sameAddress(payment.token, request.asset)) throw new Error("Payment terms mismatch");
    if (payment.rail === "permit2-witness" && payment.permit?.witness) {
      const p = payment.permit;
      if (BigInt(p.nonce) !== BigInt(request.requestHash) || BigInt(p.deadline) !== BigInt(request.expiresAt) ||
          !sameAddress(p.spender, runtime.facilitatorAddress) || !sameAddress(p.witness!.to, runtime.payTo) ||
          BigInt(p.witness!.validAfter) !== 0n) throw new Error("Permit does not bind this request");
    } else if (payment.rail === "eip3009" && payment.authorization) {
      const a = payment.authorization;
      if (a.nonce.toLowerCase() !== request.requestHash.toLowerCase() || !sameAddress(a.to, runtime.payTo) ||
          BigInt(a.validBefore) !== BigInt(request.expiresAt) || BigInt(a.validAfter) !== 0n) throw new Error("Authorization does not bind this request");
    } else throw new Error("A recipient-bound payment rail is required");
  } catch {
    throw new WriterError(400, "PAYMENT_BINDING_MISMATCH", "Signed payment must bind the exact request hash, recipient, asset, amount and deadline");
  }
}
