import type { NativeTransferAccept } from "@rebel/shared";
import { HunterError } from "../errors.js";
import { LegacyNativePaymentProvider } from "../integrations/legacy-native-provider.js";
import { AltanaSessionPaymentProvider } from "../integrations/altana/execute-provider.js";
import {
  PaymentProviderDispatcher,
  type PaymentResult
} from "../integrations/payment-provider.js";
import { hunterConfig } from "../config.js";
import { browserAuthorityContext } from '../integrations/altana/browser-context.js';

function createNativePaymentProvider() {
  if (!hunterConfig.altana.enabled) {
    return new LegacyNativePaymentProvider();
  }
  if (
    !hunterConfig.altana.authorityId ||
    !hunterConfig.altana.sessionEncryptionKey
  ) {
    throw new Error(
      "ALTANA_ENABLED requires ALTANA_AUTHORITY_ID and ALTANA_SESSION_ENCRYPTION_KEY"
    );
  }
  return new AltanaSessionPaymentProvider(
    hunterConfig.altana.authorityId,
    hunterConfig.altana.sessionStorePath,
    hunterConfig.altana.sessionEncryptionKey
  );
}

const paymentProviders = new PaymentProviderDispatcher([createNativePaymentProvider()]);

function currentProviders() {
  const scoped = browserAuthorityContext.getStore();
  if (!scoped) return paymentProviders;
  return new PaymentProviderDispatcher([new AltanaSessionPaymentProvider(scoped.authorityId, hunterConfig.altana.sessionStorePath, hunterConfig.altana.sessionEncryptionKey!)]);
}

export async function checkBalanceTool(): Promise<{
  address: string;
  balance: Awaited<ReturnType<LegacyNativePaymentProvider["getBalance"]>>["balance"];
  formatted: string;
}> {
  return currentProviders().getBalance("legacy-native");
}

export async function makePaymentTool(accept: NativeTransferAccept): Promise<PaymentResult> {
  if (accept.scheme !== "native-transfer" || accept.asset !== "native") {
    throw new HunterError(422, "UNSUPPORTED_PAYMENT_SCHEME", "Only native-transfer/native is supported");
  }

  const balance = await currentProviders().getBalance("legacy-native");
  return currentProviders().pay({
    rail: "legacy-native",
    recipient: accept.payTo,
    amount: { asset: balance.balance.asset, amount: accept.amount }
  });
}
