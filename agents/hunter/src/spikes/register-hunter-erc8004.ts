import { ethers } from "ethers";
import path from "node:path";
import {
  getOnchainIdentityRecord,
  registerAgentOnIdentityRegistry,
  upsertOnchainIdentityRecord,
  withLocalFileLock
} from "@rebel/shared";
import { hunterConfig } from "../config.js";

const CONFIRMATION = "I_CONFIRM_ERC8004_REGISTRATION";
const CANONICAL_BNB_TESTNET_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function performRegistration(): Promise<void> {
  if (hunterConfig.chainId !== 97) throw new Error("ERC-8004 registration must use BNB Testnet chain 97");
  const privateKey = requiredEnv("ALTANA_X402_ADMIN_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("ALTANA_X402_ADMIN_PRIVATE_KEY is invalid");
  const owner = new ethers.Wallet(privateKey).address;
  const registryAddress = ethers.getAddress(process.env.IDENTITY_REGISTRY_ADDRESS?.trim() || CANONICAL_BNB_TESTNET_IDENTITY_REGISTRY);
  if (registryAddress !== ethers.getAddress(CANONICAL_BNB_TESTNET_IDENTITY_REGISTRY)) {
    throw new Error("Refusing to use a non-canonical BNB Testnet ERC-8004 IdentityRegistry");
  }
  const agentUri = requiredEnv("HUNTER_AGENT_URI");
  const parsedUri = new URL(agentUri);
  if (parsedUri.protocol !== "https:" || !parsedUri.pathname.endsWith("/agent-registration.json")) {
    throw new Error("HUNTER_AGENT_URI must be the public HTTPS Hunter /agent-registration.json endpoint");
  }
  const key = ["hunter", "97", registryAddress.toLowerCase(), owner.toLowerCase()].join(":");
  const existing = await getOnchainIdentityRecord(key);
  if (existing) {
    process.stdout.write(`${JSON.stringify({ event: "erc8004_registration_already_recorded", ...existing }, null, 2)}\n`);
    return;
  }
  const rpcUrl = process.env.ALTANA_RPC_URL_OVERRIDE?.trim() || hunterConfig.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true });
  const registryCode = await provider.getCode(registryAddress);
  if (registryCode === "0x") throw new Error("Canonical ERC-8004 IdentityRegistry has no code on the selected RPC");
  const registrationResponse = await fetch(agentUri, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!registrationResponse.ok) throw new Error(`HUNTER_AGENT_URI returned HTTP ${registrationResponse.status}`);
  const registrationFile = await registrationResponse.json() as { type?: unknown; active?: unknown; services?: unknown };
  if (registrationFile.type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" ||
      registrationFile.active !== true || !Array.isArray(registrationFile.services)) {
    throw new Error("HUNTER_AGENT_URI does not return a valid active ERC-8004 registration file");
  }
  const registerInterface = new ethers.Interface([
    "function register(string agentURI) external returns (uint256 agentId)"
  ]);
  const data = registerInterface.encodeFunctionData("register", [agentUri]);
  const [balance, gasEstimate, feeData] = await Promise.all([
    provider.getBalance(owner),
    provider.estimateGas({ from: owner, to: registryAddress, data }),
    provider.getFeeData()
  ]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  const maxGasCost = gasPrice === null ? undefined : gasEstimate * gasPrice;
  process.stdout.write(`${JSON.stringify({
    event: "erc8004_registration_preview",
    broadcast: process.env.ERC8004_REGISTER_CONFIRM === CONFIRMATION,
    chainId: 97,
    owner,
    registryAddress,
    registryCodeHash: ethers.keccak256(registryCode),
    agentUri,
    calldata: data,
    gasEstimate: gasEstimate.toString(),
    gasPriceWei: gasPrice?.toString(),
    maxGasCostWei: maxGasCost?.toString(),
    ownerBalanceWei: balance.toString()
  }, null, 2)}\n`);
  if (process.env.ERC8004_REGISTER_CONFIRM !== CONFIRMATION) {
    process.stdout.write(`Preflight only. Set ERC8004_REGISTER_CONFIRM=${CONFIRMATION} only after reviewing this preview.\n`);
    return;
  }
  if (maxGasCost !== undefined && balance < maxGasCost) throw new Error("Owner has insufficient tBNB for the estimated registration gas");
  const result = await registerAgentOnIdentityRegistry({
    rpcUrl,
    chainId: 97,
    privateKey,
    registryAddress,
    agentUri
  });
  const record = {
    key,
    role: "hunter" as const,
    registryAddress,
    chainId: 97,
    walletAddress: owner,
    agentUri,
    txHash: result.txHash,
    agentTokenId: result.agentId,
    registeredAt: Math.floor(Date.now() / 1000)
  };
  await upsertOnchainIdentityRecord(record);
  process.stdout.write(`${JSON.stringify({ event: "erc8004_identity_registered", ...record }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const storePath = path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.ONCHAIN_IDENTITY_STORE_PATH ?? "./registry/onchain-identity-store.json"
  );
  // The lock spans preflight, broadcast, receipt parsing and local persistence.
  // If the process dies after broadcast it intentionally remains stale: inspect
  // the chain before removing it, rather than risking a duplicate registration.
  await withLocalFileLock(`${storePath}.registration`, performRegistration);
}

main().catch((error: unknown) => {
  process.stderr.write(`ERC-8004 registration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
