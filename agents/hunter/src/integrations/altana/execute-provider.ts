import { BNB_TESTNET, createClient } from "@altananetwork/sdk";
import { compareMoney, formatMoney, sameAddress, sameAsset } from "@rebel/shared";
import { hunterConfig } from "../../config.js";
import { HunterError } from "../../errors.js";
import type { PaymentProvider, PaymentRequest, PaymentResult } from "../payment-provider.js";
import { loadActiveAltanaAuthority } from "./authority.js";
import { restoreAltanaSession } from "./session-codec.js";

export class AltanaSessionPaymentProvider implements PaymentProvider {
  readonly rail = "legacy-native" as const;
  private readonly client = createClient({ chains: [BNB_TESTNET] });

  constructor(
    private readonly authorityId: string,
    private readonly storePath: string,
    private readonly encryptionKey: string
  ) {
    if (hunterConfig.chainId !== BNB_TESTNET.chainId) {
      throw new Error("Altana session payment currently requires BNB Testnet (chain 97)");
    }
  }

  private async loadActiveRecord() {
    return loadActiveAltanaAuthority({
      authorityId: this.authorityId,
      storePath: this.storePath,
      evidencePath: hunterConfig.altana.authorityEvidencePath,
      encryptionKey: this.encryptionKey
    });
  }

  async getBalance() {
    const record = await this.loadActiveRecord();
    const balances = await this.client.balances({
      wallet: record.session.walletAddress,
      chainId: BNB_TESTNET.chainId
    });
    const balance = {
      asset: hunterConfig.chain.nativeAsset,
      amount: balances.native.toString()
    };
    return {
      address: record.session.walletAddress,
      balance,
      formatted: `${formatMoney(balance, { maxFractionDigits: 6 })} ${balance.asset.symbol}`
    };
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    if (request.rail !== this.rail) {
      throw new HunterError(422, "UNSUPPORTED_PAYMENT_RAIL", `Expected ${this.rail} rail`);
    }
    if (request.amount.asset.kind !== "native" || !sameAsset(request.amount.asset, hunterConfig.chain.nativeAsset)) {
      throw new HunterError(422, "UNSUPPORTED_ASSET", "Altana execute provider requires the active native asset");
    }
    const record = await this.loadActiveRecord();
    const allowed = record.authority.allowedCalls.some((call) => sameAddress(call.to, request.recipient));
    if (!allowed) {
      throw new HunterError(403, "AUTHORITY_CALL_NOT_ALLOWED", "Payment recipient is not on the authority allowlist");
    }
    const spendLimit = record.authority.spendLimits.find((limit) => sameAsset(limit.asset, request.amount.asset));
    if (!spendLimit || compareMoney(request.amount, { asset: spendLimit.asset, amount: spendLimit.limit }) > 0) {
      throw new HunterError(403, "AUTHORITY_SPEND_EXCEEDED", "Payment exceeds the authority spend limit");
    }

    const session = restoreAltanaSession(record);
    const result = await this.client.execute({
      session,
      chainId: BNB_TESTNET.chainId,
      calls: [{ to: request.recipient as `0x${string}`, value: BigInt(request.amount.amount) }]
    });
    if (result.status !== "CONFIRMED" || !result.transactionHash) {
      throw new HunterError(422, "SETTLEMENT_FAILED", "Altana session payment was not confirmed", {
        callsId: result.callsId,
        status: result.status,
        transactionHash: result.transactionHash
      });
    }
    return {
      rail: this.rail,
      txHash: result.transactionHash,
      from: session.walletAddress,
      to: request.recipient,
      amount: request.amount
    };
  }
}
