import { ethers } from "ethers";
import {
  type OnchainIdentityRecord,
  getOnchainIdentityRecord,
  registerAgentOnIdentityRegistry,
  setAgentWalletOnIdentityRegistry,
  upsertOnchainIdentityRecord
} from "@rebel/shared";
import { hunterConfig } from "./config.js";

function getOnchainRegistrationKey(): string | undefined {
  if (!hunterConfig.identity.onchain.registryAddress || !hunterConfig.identity.onchain.ownerAddress) {
    return undefined;
  }
  const walletAddress = hunterConfig.identity.onchain.ownerAddress.toLowerCase();
  return [
    "hunter",
    hunterConfig.chainId.toString(10),
    hunterConfig.identity.onchain.registryAddress.toLowerCase(),
    walletAddress
  ].join(":");
}

export async function getHunterOnChainRegistrationStatus(): Promise<{
  enabled: boolean;
  registryAddress?: string;
  agentUri?: string;
  registered: boolean;
  txHash?: string;
  agentTokenId?: string;
  walletBinding: {
    enabled: boolean;
    targetWallet?: string;
    configured: boolean;
    bound: boolean;
    txHash?: string;
    signatureProfileId?: string;
  };
}> {
  const walletTarget = hunterConfig.identity.onchain.wallet.address;
  const key = getOnchainRegistrationKey();
  if (!key) {
    return {
      enabled: hunterConfig.identity.onchain.enabled,
      registryAddress: hunterConfig.identity.onchain.registryAddress,
      agentUri: hunterConfig.identity.onchain.agentUri,
      registered: false,
      walletBinding: {
        enabled: hunterConfig.identity.onchain.wallet.enabled,
        targetWallet: walletTarget,
        configured: Boolean(walletTarget),
        bound: false
      }
    };
  }
  const existing = await getOnchainIdentityRecord(key);
  return {
    enabled: hunterConfig.identity.onchain.enabled,
    registryAddress: hunterConfig.identity.onchain.registryAddress,
    agentUri: hunterConfig.identity.onchain.agentUri,
    registered: Boolean(existing),
    txHash: existing?.txHash,
    agentTokenId: existing?.agentTokenId,
    walletBinding: {
      enabled: hunterConfig.identity.onchain.wallet.enabled,
      targetWallet: walletTarget,
      configured: Boolean(walletTarget),
      bound: Boolean(
        walletTarget &&
          existing?.agentWalletAddress &&
          existing.agentWalletAddress.toLowerCase() === walletTarget.toLowerCase()
      ),
      txHash: existing?.agentWalletSetTxHash,
      signatureProfileId: existing?.agentWalletSignatureProfileId
    }
  };
}

async function maybeBindHunterAgentWallet(record: OnchainIdentityRecord): Promise<void> {
  const walletConfig = hunterConfig.identity.onchain.wallet;
  if (!walletConfig.enabled) {
    return;
  }
  if (!record.agentTokenId) {
    console.warn("[hunter] setAgentWallet skipped: missing on-chain agent token id");
    return;
  }
  if (!walletConfig.address) {
    console.warn("[hunter] setAgentWallet skipped: HUNTER_AGENT_WALLET_ADDRESS is missing/invalid");
    return;
  }

  try {
    const result = await setAgentWalletOnIdentityRegistry({
      rpcUrl: hunterConfig.rpcUrl,
      chainId: hunterConfig.chainId,
      ownerPrivateKey: hunterConfig.privateKey!,
      registryAddress: record.registryAddress,
      agentId: record.agentTokenId,
      newWalletAddress: walletConfig.address,
      newWalletSignerPrivateKey: walletConfig.signerPrivateKey,
      deadlineSeconds: walletConfig.deadlineSeconds,
      signatureProfile: {
        id: "hunter-configured",
        domainName: walletConfig.signature.domainName,
        domainVersion: walletConfig.signature.domainVersion,
        typeName: walletConfig.signature.typeName,
        includeOwner: walletConfig.signature.includeOwner
      },
      allowLegacyFallback: walletConfig.signature.allowLegacyFallback
    });

    await upsertOnchainIdentityRecord({
      ...record,
      agentWalletAddress: result.targetWallet,
      agentWalletSetTxHash: result.txHash ?? record.agentWalletSetTxHash,
      agentWalletSetAt: result.txHash
        ? Math.floor(Date.now() / 1000)
        : (record.agentWalletSetAt ?? Math.floor(Date.now() / 1000)),
      agentWalletSetDeadline: result.deadline ?? record.agentWalletSetDeadline,
      agentWalletSignatureProfileId: result.profileId ?? record.agentWalletSignatureProfileId
    });

    if (result.skipped) {
      console.log(`[hunter] setAgentWallet skipped: ${result.reason}`);
    } else {
      console.log(
        `[hunter] on-chain agent wallet set | wallet=${result.targetWallet} | tx=${result.txHash} | profile=${result.profileId}`
      );
    }
  } catch (error) {
    console.error(
      `[hunter] on-chain setAgentWallet failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function registerHunterIdentityOnChain(): Promise<void> {
  if (!hunterConfig.identity.onchain.enabled) {
    return;
  }
  if (!hunterConfig.identity.onchain.registryAddress) {
    console.warn("[hunter] on-chain registration enabled but IDENTITY_REGISTRY_ADDRESS is missing");
    return;
  }
  if (!hunterConfig.privateKey) {
    console.warn("[hunter] on-chain registration enabled but HUNTER_PRIVATE_KEY is missing");
    return;
  }

  const key = getOnchainRegistrationKey();
  if (!key) {
    return;
  }

  let record = await getOnchainIdentityRecord(key);
  if (record) {
    console.log(
      `[hunter] on-chain identity already registered | tx=${record.txHash}${record.agentTokenId ? ` | agentId=${record.agentTokenId}` : ""}`
    );
  } else {
    try {
      const walletAddress = new ethers.Wallet(hunterConfig.privateKey).address;
      const result = await registerAgentOnIdentityRegistry({
        rpcUrl: hunterConfig.rpcUrl,
        chainId: hunterConfig.chainId,
        privateKey: hunterConfig.privateKey,
        registryAddress: hunterConfig.identity.onchain.registryAddress,
        agentUri: hunterConfig.identity.onchain.agentUri
      });
      record = {
        key,
        role: "hunter",
        registryAddress: hunterConfig.identity.onchain.registryAddress,
        chainId: hunterConfig.chainId,
        walletAddress,
        agentUri: hunterConfig.identity.onchain.agentUri,
        txHash: result.txHash,
        agentTokenId: result.agentId,
        registeredAt: Math.floor(Date.now() / 1000)
      };
      await upsertOnchainIdentityRecord(record);
      console.log(
        `[hunter] on-chain identity registered | tx=${result.txHash}${result.agentId ? ` | agentId=${result.agentId}` : ""}`
      );
    } catch (error) {
      console.error(
        `[hunter] on-chain registration failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  }

  await maybeBindHunterAgentWallet(record);
}
