import type { AssetRef } from "./types.js";

export type ChainPresetName = "bnb-testnet" | "monad-testnet";

export interface ChainPreset {
  preset: ChainPresetName;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeAsset: AssetRef;
}

export const BNB_TESTNET_CHAIN: ChainPreset = {
  preset: "bnb-testnet",
  chainId: 97,
  name: "BNB Smart Chain Testnet",
  rpcUrl: "https://bsc-testnet-dataseed.bnbchain.org",
  explorerUrl: "https://testnet.bscscan.com",
  nativeAsset: {
    chainId: 97,
    kind: "native",
    symbol: "tBNB",
    decimals: 18
  }
};

export const MONAD_TESTNET_CHAIN: ChainPreset = {
  preset: "monad-testnet",
  chainId: 10143,
  name: "Monad Testnet",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadexplorer.com",
  nativeAsset: {
    chainId: 10143,
    kind: "native",
    symbol: "MON",
    decimals: 18
  }
};

const CHAIN_PRESETS: Record<ChainPresetName, ChainPreset> = {
  "bnb-testnet": BNB_TESTNET_CHAIN,
  "monad-testnet": MONAD_TESTNET_CHAIN
};

export function isChainPresetName(value: string): value is ChainPresetName {
  return value in CHAIN_PRESETS;
}

export function getChainPreset(value?: string): ChainPreset {
  const normalized = value?.trim().toLowerCase() ?? "bnb-testnet";
  if (!isChainPresetName(normalized)) {
    throw new Error(`Unsupported CHAIN_PRESET: ${value}`);
  }
  return CHAIN_PRESETS[normalized];
}

export function resolveChainConfig(input: {
  preset?: string;
  chainId?: string;
  rpcUrl?: string;
}): ChainPreset {
  const base = getChainPreset(input.preset);
  const chainId = input.chainId?.trim() ? Number(input.chainId) : base.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid CHAIN_ID: ${input.chainId}`);
  }

  const rpcUrl = input.rpcUrl?.trim() || base.rpcUrl;
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("RPC URL must use http or https");
    }
  } catch {
    throw new Error(`Invalid RPC_URL: ${rpcUrl}`);
  }

  return {
    ...base,
    chainId,
    rpcUrl,
    nativeAsset: {
      ...base.nativeAsset,
      chainId
    }
  };
}
