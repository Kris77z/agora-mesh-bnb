import {
  U_TOKEN,
  createX402Merchant,
  type HandleResult
} from "@altananetwork/x402-server";
import { bsc, bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { writerConfig } from "../config.js";

export interface X402MerchantHandle {
  requirePayment(header: string | null): Promise<HandleResult>;
}

export interface X402MerchantFactory {
  get(input: {
    requestHash: string;
    resourceUrl: string;
    description: string;
    price: string;
  }): X402MerchantHandle;
}

function requireSupportedChain(chainId: number) {
  if (chainId === 56) {
    return bsc;
  }
  if (chainId === 97) {
    return bscTestnet;
  }
  throw new Error(`Altana x402 merchant only supports BNB chains 56 and 97, got ${chainId}`);
}

export class AltanaX402MerchantFactory implements X402MerchantFactory {
  private readonly merchants = new Map<string, X402MerchantHandle>();

  get(input: {
    requestHash: string;
    resourceUrl: string;
    description: string;
    price: string;
  }): X402MerchantHandle {
    const cacheKey = `${input.requestHash}:${input.price}`;
    const existing = this.merchants.get(cacheKey);
    if (existing) {
      return existing;
    }
    if (!writerConfig.x402.enabled) {
      throw new Error("X402_ENABLED is false");
    }
    if (!writerConfig.x402.facilitatorPrivateKey) {
      throw new Error("X402_ENABLED requires X402_FACILITATOR_PRIVATE_KEY");
    }
    const price = BigInt(input.price);
    const minPrice = BigInt(writerConfig.x402.minPriceAmount);
    const maxPrice = BigInt(writerConfig.x402.maxPriceAmount);
    if (price < minPrice || price > maxPrice) {
      throw new Error(`x402 price ${price} is outside configured bounds [${minPrice}, ${maxPrice}]`);
    }

    const chainId = writerConfig.chainId as 56 | 97;
    const chain = requireSupportedChain(chainId);
    const token = U_TOKEN[chainId];
    if (!token) {
      throw new Error(`No $U token configuration for chain ${chainId}`);
    }
    const facilitator = privateKeyToAccount(
      writerConfig.x402.facilitatorPrivateKey as `0x${string}`
    );
    const rails = [
      ...(writerConfig.x402.rail === "eip3009" || writerConfig.x402.rail === "both"
        ? [{ rail: "eip3009" as const, token }]
        : []),
      ...(writerConfig.x402.rail === "permit2" || writerConfig.x402.rail === "both"
        ? [{ rail: "permit2-exact" as const, token, spender: facilitator.address }]
        : [])
    ];
    const merchant = createX402Merchant({
      chainId,
      payTo: writerConfig.x402.payTo as `0x${string}`,
      price,
      minPrice,
      maxPrice,
      rails,
      resource: {
        url: input.resourceUrl,
        description: input.description,
        mimeType: "application/json"
      },
      description: input.description,
      maxTimeoutSeconds: Math.min(writerConfig.paymentTimeoutSeconds, 480),
      facilitator,
      rpcUrl: writerConfig.rpcUrl,
      chain
    });
    this.merchants.set(cacheKey, merchant);
    return merchant;
  }
}
