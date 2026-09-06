import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Money } from "@rebel/shared";
import {
  PaymentProviderDispatcher,
  type PaymentProvider,
  type PaymentRequest,
  type PaymentResult
} from "./payment-provider.js";

const AMOUNT: Money = {
  asset: { chainId: 97, kind: "native", symbol: "tBNB", decimals: 18 },
  amount: "1"
};

function fakeProvider(rail: PaymentProvider["rail"]): PaymentProvider {
  return {
    rail,
    async getBalance() {
      return { address: "0x1", balance: AMOUNT, formatted: "0.000000000000000001" };
    },
    async pay(request: PaymentRequest): Promise<PaymentResult> {
      return {
        rail,
        txHash: "0xtx",
        from: "0x1",
        to: request.recipient,
        amount: request.amount
      };
    }
  };
}

describe("PaymentProviderDispatcher", () => {
  it("routes requests by payment rail", async () => {
    const dispatcher = new PaymentProviderDispatcher([
      fakeProvider("legacy-native"),
      fakeProvider("x402")
    ]);
    const result = await dispatcher.pay({
      rail: "x402",
      recipient: "0x2",
      amount: AMOUNT
    });
    assert.equal(result.rail, "x402");
    assert.equal(result.to, "0x2");
  });

  it("rejects an unconfigured rail", () => {
    const dispatcher = new PaymentProviderDispatcher([fakeProvider("legacy-native")]);
    assert.throws(
      () => dispatcher.pay({ rail: "x402", recipient: "0x2", amount: AMOUNT }),
      /No payment provider configured/
    );
  });

  it("rejects duplicate provider registrations", () => {
    assert.throws(
      () =>
        new PaymentProviderDispatcher([
          fakeProvider("legacy-native"),
          fakeProvider("legacy-native")
        ]),
      /Duplicate payment provider/
    );
  });
});
