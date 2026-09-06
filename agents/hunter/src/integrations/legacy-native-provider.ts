import { compareMoney } from "@rebel/shared";
import { hunterConfig } from "../config.js";
import { HunterError } from "../errors.js";
import { checkHunterBalance, makeNativePayment } from "../wallet.js";
import type {
  PaymentProvider,
  PaymentRequest,
  PaymentResult
} from "./payment-provider.js";

export class LegacyNativePaymentProvider implements PaymentProvider {
  readonly rail = "legacy-native" as const;

  getBalance() {
    return checkHunterBalance();
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    if (request.rail !== this.rail) {
      throw new HunterError(422, "UNSUPPORTED_PAYMENT_RAIL", `Expected ${this.rail} rail`);
    }
    if (request.amount.asset.kind !== "native") {
      throw new HunterError(422, "UNSUPPORTED_ASSET", "Legacy native provider only accepts native assets");
    }

    const current = await this.getBalance();
    if (compareMoney(current.balance, request.amount) < 0) {
      throw new HunterError(
        422,
        "INSUFFICIENT_BALANCE",
        `Hunter wallet has insufficient ${hunterConfig.chain.nativeAsset.symbol} balance`,
        { balance: current.balance, required: request.amount }
      );
    }

    const payment = await makeNativePayment({
      to: request.recipient,
      amount: request.amount
    });
    return { rail: this.rail, ...payment };
  }
}
