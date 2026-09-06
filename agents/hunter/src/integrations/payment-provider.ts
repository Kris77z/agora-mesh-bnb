import type { Money, PaymentRail } from "@rebel/shared";
import { HunterError } from "../errors.js";

export interface PaymentRequest {
  rail: PaymentRail;
  recipient: string;
  amount: Money;
  missionId?: string;
  serviceId?: string;
  requestHash?: string;
}

export interface PaymentResult {
  rail: PaymentRail;
  txHash: string;
  from: string;
  to: string;
  amount: Money;
}

export interface PaymentProvider {
  readonly rail: PaymentRail;
  getBalance(): Promise<{ address: string; balance: Money; formatted: string }>;
  pay(request: PaymentRequest): Promise<PaymentResult>;
}

export class PaymentProviderDispatcher {
  private readonly providers: Map<PaymentRail, PaymentProvider>;

  constructor(providers: PaymentProvider[]) {
    this.providers = new Map();
    for (const provider of providers) {
      if (this.providers.has(provider.rail)) {
        throw new Error(`Duplicate payment provider for rail: ${provider.rail}`);
      }
      this.providers.set(provider.rail, provider);
    }
  }

  getProvider(rail: PaymentRail): PaymentProvider {
    const provider = this.providers.get(rail);
    if (!provider) {
      throw new HunterError(
        422,
        "UNSUPPORTED_PAYMENT_RAIL",
        `No payment provider configured for rail: ${rail}`
      );
    }
    return provider;
  }

  getBalance(rail: PaymentRail) {
    return this.getProvider(rail).getBalance();
  }

  pay(request: PaymentRequest) {
    return this.getProvider(request.rail).pay(request);
  }
}
