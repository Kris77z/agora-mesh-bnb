import { ethers } from "ethers";

const IDENTITY_REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address owner)",
  "function getAgentWallet(uint256 agentId) view returns (address wallet)",
  "function setAgentWallet(uint256 agentId,address newWallet,uint256 deadline,bytes signature) external",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
];

export async function registerAgentOnIdentityRegistry(input: {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  registryAddress: string;
  agentUri: string;
}): Promise<{
  txHash: string;
  agentId?: string;
}> {
  const provider = new ethers.JsonRpcProvider(input.rpcUrl, input.chainId);
  const wallet = new ethers.Wallet(input.privateKey, provider);
  const registry = new ethers.Contract(input.registryAddress, IDENTITY_REGISTRY_ABI, wallet);

  const tx = await registry.register(input.agentUri);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`ERC-8004 registration transaction was not confirmed successfully: ${tx.hash}`);
  }

  let agentId: string | undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed && parsed.name === "Registered") {
        const id = parsed.args?.agentId;
        agentId = typeof id === "bigint" ? id.toString(10) : undefined;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!agentId) throw new Error(`ERC-8004 registration receipt did not contain a Registered event: ${tx.hash}`);

  return {
    txHash: tx.hash,
    agentId
  };
}

export interface AgentWalletSignatureProfile {
  id: string;
  domainName: string;
  domainVersion: string;
  typeName: string;
  includeOwner: boolean;
}

const DEFAULT_SIGNATURE_PROFILES: AgentWalletSignatureProfile[] = [
  {
    id: "erc8004-v1.1",
    domainName: "ERC-8004 IdentityRegistry",
    domainVersion: "1.1",
    typeName: "SetAgentWallet",
    includeOwner: false
  },
  {
    id: "erc8004-v1.0-legacy",
    domainName: "ERC8004IdentityRegistry",
    domainVersion: "1",
    typeName: "AgentWalletSet",
    includeOwner: true
  }
];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLikelySignatureError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("signature") ||
    message.includes("ecdsa") ||
    message.includes("recover") ||
    message.includes("missing revert data")
  );
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function isZeroAddress(address: string): boolean {
  return normalizeAddress(address) === ethers.ZeroAddress;
}

export async function setAgentWalletOnIdentityRegistry(input: {
  rpcUrl: string;
  chainId: number;
  ownerPrivateKey: string;
  registryAddress: string;
  agentId: string;
  newWalletAddress: string;
  newWalletSignerPrivateKey?: string;
  deadlineSeconds?: number;
  signatureProfile?: AgentWalletSignatureProfile;
  allowLegacyFallback?: boolean;
}): Promise<{
  txHash?: string;
  skipped: boolean;
  reason?: string;
  profileId?: string;
  deadline?: number;
  targetWallet: string;
}> {
  const provider = new ethers.JsonRpcProvider(input.rpcUrl, input.chainId);
  const ownerWallet = new ethers.Wallet(input.ownerPrivateKey, provider);
  const registryAddress = normalizeAddress(input.registryAddress);
  const registry = new ethers.Contract(registryAddress, IDENTITY_REGISTRY_ABI, ownerWallet);
  const agentId = BigInt(input.agentId);
  const targetWallet = normalizeAddress(input.newWalletAddress);
  if (isZeroAddress(targetWallet)) {
    throw new Error("newWalletAddress must be a non-zero address");
  }

  const currentWallet = normalizeAddress((await registry.getAgentWallet(agentId)) as string);
  if (!isZeroAddress(currentWallet) && currentWallet === targetWallet) {
    return {
      skipped: true,
      reason: "agent wallet already set",
      targetWallet
    };
  }

  const signerPrivateKey =
    input.newWalletSignerPrivateKey?.trim() !== ""
      ? input.newWalletSignerPrivateKey
      : ownerWallet.address === targetWallet
        ? input.ownerPrivateKey
        : undefined;
  if (!signerPrivateKey) {
    throw new Error(
      "setAgentWallet requires NEW wallet signature; provide *_AGENT_WALLET_SIGNER_PRIVATE_KEY or use owner wallet as target wallet"
    );
  }
  const newWalletSigner = new ethers.Wallet(signerPrivateKey);
  if (newWalletSigner.address !== targetWallet) {
    throw new Error(
      `new wallet signer mismatch: signer=${newWalletSigner.address} target=${targetWallet}`
    );
  }

  const owner = normalizeAddress((await registry.ownerOf(agentId)) as string);
  const deadline = Math.floor(Date.now() / 1000) + (input.deadlineSeconds ?? 300);
  const configuredProfile = input.signatureProfile ?? DEFAULT_SIGNATURE_PROFILES[0];
  const profiles = input.allowLegacyFallback
    ? [configuredProfile, ...DEFAULT_SIGNATURE_PROFILES.filter((item) => item.id !== configuredProfile.id)]
    : [configuredProfile];

  const attempts: Array<{ profileId: string; message: string }> = [];
  let lastError: unknown;

  for (const profile of profiles) {
    try {
      const domain = {
        name: profile.domainName,
        version: profile.domainVersion,
        chainId: input.chainId,
        verifyingContract: registryAddress
      };
      const fields: Array<{ name: string; type: string }> = [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "deadline", type: "uint256" }
      ];
      if (profile.includeOwner) {
        fields.push({ name: "owner", type: "address" });
      }
      const types = {
        [profile.typeName]: fields
      };
      const message: Record<string, string | number> = {
        agentId: input.agentId,
        newWallet: targetWallet,
        deadline
      };
      if (profile.includeOwner) {
        message.owner = owner;
      }

      const signature = await newWalletSigner.signTypedData(domain, types, message);
      const tx = await registry.setAgentWallet(agentId, targetWallet, BigInt(deadline), signature);
      await tx.wait(1);

      return {
        txHash: tx.hash,
        skipped: false,
        profileId: profile.id,
        deadline,
        targetWallet
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        profileId: profile.id,
        message: toErrorMessage(error)
      });
      if (!isLikelySignatureError(error)) {
        throw error;
      }
    }
  }

  throw new Error(
    `setAgentWallet failed for all signature profiles (${attempts.map((item) => `${item.profileId}: ${item.message}`).join(" | ")})${lastError ? ` | lastError=${toErrorMessage(lastError)}` : ""}`
  );
}
