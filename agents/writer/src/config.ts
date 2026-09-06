import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { ethers } from "ethers";
import { readStoreBackendConfig, resolveChainConfig } from "@rebel/shared";

loadDotenv({ path: path.resolve(process.env.INIT_CWD ?? process.cwd(), ".env") });

function mustNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number env: ${name}`);
  }
  return parsed;
}

function numberFromValue(raw: string | undefined, fallback: number, label: string): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number env: ${label}`);
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === "true";
}

function normalizePrivateKey(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === "" || raw === "0x...") {
    return undefined;
  }
  try {
    // ethers validates both format and value domain.
    return new ethers.Wallet(raw).privateKey;
  } catch {
    return undefined;
  }
}

function normalizeAddress(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === "" || raw === "0x...") {
    return undefined;
  }
  try {
    return ethers.getAddress(raw);
  } catch {
    return undefined;
  }
}

function normalizeApiKey(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === "" || raw.includes("...")) {
    return undefined;
  }
  return raw.trim();
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function mustIntegerAmount(name: string, fallback: string, configured?: string): string {
  const raw = configured?.trim() || process.env[name]?.trim() || fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid integer amount env: ${name}`);
  }
  return raw;
}

type ServiceProfile = "all" | "writer" | "auditor" | "sentinel" | "verifier" | "investigator";

function resolveServiceProfile(raw: string | undefined): ServiceProfile {
  const profile = raw?.trim().toLowerCase() || "all";
  if (
    profile !== "all" &&
    profile !== "writer" &&
    profile !== "auditor" &&
    profile !== "sentinel" &&
    profile !== "verifier" &&
    profile !== "investigator"
  ) {
    throw new Error(`Unsupported SERVICE_PROFILE: ${raw}`);
  }
  return profile;
}

function resolveX402Rail(raw: string | undefined): "permit2" | "eip3009" | "both" {
  const rail = raw?.trim().toLowerCase() || "permit2";
  if (rail !== "permit2" && rail !== "eip3009" && rail !== "both") {
    throw new Error(`Unsupported X402_RAIL: ${raw}`);
  }
  return rail;
}

const serviceProfile = resolveServiceProfile(process.env.SERVICE_PROFILE);
const profilePrefix = serviceProfile === "all" ? undefined : serviceProfile.toUpperCase();
const profileEnv = (suffix: string): string | undefined =>
  profilePrefix ? process.env[`${profilePrefix}_${suffix}`]?.trim() || undefined : undefined;
const genericProfile = serviceProfile === "all" || serviceProfile === "writer";

const explicitPrivateKey = normalizePrivateKey(
  profileEnv("PRIVATE_KEY") ??
    process.env.SERVICE_PRIVATE_KEY ??
    (genericProfile ? process.env.WRITER_PRIVATE_KEY : undefined)
);
const explicitAddress = normalizeAddress(
  profileEnv("ADDRESS") ??
    process.env.SERVICE_ADDRESS ??
    (genericProfile ? process.env.WRITER_ADDRESS : undefined)
);
const devWallet = ethers.Wallet.createRandom();
const mockMode = !explicitPrivateKey;
const kimiApiKey = normalizeApiKey(profileEnv("KIMI_API_KEY") ?? process.env.KIMI_API_KEY);
const openaiApiKey = normalizeApiKey(profileEnv("OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY);
const requestedProvider = profileEnv("LLM_PROVIDER");
if (requestedProvider && requestedProvider !== "kimi" && requestedProvider !== "openai") throw new Error("Profile LLM_PROVIDER must be kimi or openai");
const llmProvider = requestedProvider ?? (kimiApiKey ? "kimi" : openaiApiKey ? "openai" : "none");
const llmTimeoutMs = numberFromValue(
  profileEnv("LLM_TIMEOUT_MS") ?? process.env.LLM_TIMEOUT_MS,
  300_000,
  `${profilePrefix ?? "WRITER"}_LLM_TIMEOUT_MS`
);
if (!Number.isSafeInteger(llmTimeoutMs) || llmTimeoutMs < 1_000 || llmTimeoutMs > 900_000) {
  throw new Error("LLM timeout must be an integer between 1000 and 900000 ms");
}
const defaultPort = serviceProfile === "sentinel" ? 3006 : serviceProfile === "verifier" ? 3004 : serviceProfile === "investigator" ? 3005 : 3001;
const port = numberFromValue(
  profileEnv("PORT") ??
    process.env.SERVICE_PORT ??
    (genericProfile ? process.env.WRITER_PORT : undefined),
  defaultPort,
  `${profilePrefix ?? "WRITER"}_PORT`
);
const publicEndpoint =
  profileEnv("PUBLIC_ENDPOINT") ??
  process.env.SERVICE_PUBLIC_ENDPOINT ??
  (genericProfile ? process.env.WRITER_PUBLIC_ENDPOINT : undefined) ??
  `http://localhost:${port}`;
const registryServiceUrl = process.env.REGISTRY_SERVICE_URL ?? "http://localhost:3003";
const chain = resolveChainConfig({
  preset: process.env.CHAIN_PRESET,
  chainId: process.env.CHAIN_ID,
  rpcUrl:
    process.env.RPC_URL ??
    (process.env.CHAIN_PRESET === "monad-testnet" ? process.env.MONAD_RPC_URL : undefined)
});
const defaultProfileSkillIds: Record<ServiceProfile, string[]> = {
  all: [],
  writer: ["writer-v1"],
  auditor: ["auditor-v1"],
  sentinel: ["sentinel-audit-v1"],
  verifier: ["verifier-v1", "risk-verifier-v1"],
  investigator: ["investigator-v1"]
};
const x402Enabled = parseBoolean(profileEnv("X402_ENABLED") ?? process.env.X402_ENABLED, false);
const defaultX402PriceAmount =
  serviceProfile === "auditor"
    ? "500000000000000000"
    : serviceProfile === "sentinel"
      ? "400000000000000000"
    : serviceProfile === "verifier"
      ? "250000000000000000"
      : serviceProfile === "investigator"
        ? "350000000000000000"
        : "100000000000000000";

const writerAddress = mockMode ? devWallet.address : new ethers.Wallet(explicitPrivateKey!).address;
const writerPrivateKey = mockMode ? devWallet.privateKey : explicitPrivateKey!;
const configuredX402PayTo = normalizeAddress(
  profileEnv("X402_PAY_TO_ADDRESS") ??
    (genericProfile ? process.env.X402_PAY_TO_ADDRESS : undefined)
);
const x402FacilitatorPrivateKey = normalizePrivateKey(
  profileEnv("X402_FACILITATOR_PRIVATE_KEY") ??
    (genericProfile ? process.env.X402_FACILITATOR_PRIVATE_KEY : undefined)
);
const x402PriceAmount = mustIntegerAmount(
  profilePrefix ? `${profilePrefix}_X402_PRICE_AMOUNT` : "X402_PRICE_AMOUNT",
  defaultX402PriceAmount,
  profileEnv("X402_PRICE_AMOUNT") ?? process.env.X402_PRICE_AMOUNT
);
const x402MinPriceAmount = mustIntegerAmount(
  profilePrefix ? `${profilePrefix}_X402_MIN_PRICE_AMOUNT` : "X402_MIN_PRICE_AMOUNT",
  "1",
  profileEnv("X402_MIN_PRICE_AMOUNT") ?? process.env.X402_MIN_PRICE_AMOUNT
);
const x402MaxPriceAmount = mustIntegerAmount(
  profilePrefix ? `${profilePrefix}_X402_MAX_PRICE_AMOUNT` : "X402_MAX_PRICE_AMOUNT",
  "10000000000000000000",
  profileEnv("X402_MAX_PRICE_AMOUNT") ?? process.env.X402_MAX_PRICE_AMOUNT
);

if (configuredX402PayTo && configuredX402PayTo.toLowerCase() !== writerAddress.toLowerCase()) {
  throw new Error("X402_PAY_TO_ADDRESS must match the active Service Profile wallet identity");
}
if (x402Enabled && mockMode) {
  throw new Error("x402 requires a persistent Service Profile private key; random mock wallets cannot receive paid tasks");
}
if (serviceProfile === "sentinel" && explicitPrivateKey &&
    explicitPrivateKey === normalizePrivateKey(process.env.AUDITOR_PRIVATE_KEY)) {
  throw new Error("Sentinel requires a wallet distinct from Auditor");
}
if (x402Enabled && !x402FacilitatorPrivateKey) {
  throw new Error("X402_ENABLED requires a valid X402_FACILITATOR_PRIVATE_KEY");
}
if (
  BigInt(x402MinPriceAmount) > BigInt(x402PriceAmount) ||
  BigInt(x402PriceAmount) > BigInt(x402MaxPriceAmount)
) {
  throw new Error("X402_PRICE_AMOUNT must be within X402_MIN_PRICE_AMOUNT and X402_MAX_PRICE_AMOUNT");
}

if (!explicitPrivateKey && explicitAddress && explicitAddress !== writerAddress) {
  console.warn(
    `[writer] WRITER_ADDRESS (${explicitAddress}) is ignored in mock mode; using ${writerAddress}`
  );
}

export const writerConfig = {
  port,
  chain,
  chainId: chain.chainId,
  rpcUrl: chain.rpcUrl,
  priceWei: process.env.PRICE_WEI ?? "10000000000000000",
  paymentTimeoutSeconds: mustNumber("PAYMENT_TIMEOUT_SECONDS", 60),
  httpBodyLimit: process.env.SECURITY_HTTP_BODY_LIMIT?.trim() || "3mb",
  httpSecurity: {
    allowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, ["http://localhost:3000"]),
    apiAuthToken: firstNonEmpty(profileEnv("API_AUTH_TOKEN"), process.env.WRITER_API_AUTH_TOKEN, process.env.API_AUTH_TOKEN),
    rateLimitPerMinute: mustNumber("WRITER_RATE_LIMIT_PER_MINUTE", 180),
    production: process.env.NODE_ENV === "production"
  },
  investigator: {
    rpcTimeoutMs: numberFromValue(
      profileEnv("RPC_TIMEOUT_MS") ?? process.env.INVESTIGATOR_RPC_TIMEOUT_MS,
      10_000,
      "INVESTIGATOR_RPC_TIMEOUT_MS"
    ),
    rpcAttempts: numberFromValue(
      profileEnv("RPC_ATTEMPTS") ?? process.env.INVESTIGATOR_RPC_ATTEMPTS,
      2,
      "INVESTIGATOR_RPC_ATTEMPTS"
    )
  },
  riskVerifier: {
    rpcUrl:
      process.env.RISK_VERIFIER_RPC_URL ??
      "https://bsc-testnet-rpc.publicnode.com"
  },
  writerAddress,
  writerPrivateKey,
  llm: {
    provider: llmProvider,
    apiKey: llmProvider === "kimi" ? kimiApiKey : llmProvider === "openai" ? openaiApiKey : undefined,
    model: profileEnv("LLM_MODEL") ?? (llmProvider === "kimi" ? process.env.KIMI_MODEL ?? "kimi-k2.5" : process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
    baseURL:
      profileEnv("LLM_BASE_URL") ?? (llmProvider === "kimi"
        ? process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1"
        : process.env.OPENAI_BASE_URL),
    timeoutMs: llmTimeoutMs
  },
  isMockMode: mockMode,
  persistence: readStoreBackendConfig(),
  skipPaymentVerification: mockMode
    ? true
    : parseBoolean(process.env.WRITER_SKIP_PAYMENT_VERIFICATION, false),
  publicEndpoint,
  service: {
    id: process.env.WRITER_SERVICE_ID ?? "writer-v1",
    name: process.env.WRITER_SERVICE_NAME ?? "AI Content Writer",
    description:
      process.env.WRITER_SERVICE_DESCRIPTION ??
      "Generate articles, tweets, and analysis using AI"
  },
  serviceProfile,
  serviceSkillIds: parseCsv(process.env.SERVICE_SKILL_IDS, defaultProfileSkillIds[serviceProfile]),
  x402: {
    enabled: x402Enabled,
    rail: resolveX402Rail(process.env.X402_RAIL),
    facilitatorPrivateKey: x402FacilitatorPrivateKey,
    payTo: configuredX402PayTo ?? writerAddress,
    priceAmount: x402PriceAmount,
    minPriceAmount: x402MinPriceAmount,
    maxPriceAmount: x402MaxPriceAmount,
    receiptStorePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      firstNonEmpty(profileEnv("X402_RECEIPT_STORE_PATH"), process.env.X402_RECEIPT_STORE_PATH) ??
        `./registry/x402-${serviceProfile}-receipts.json`
    )
  },
  discovery: {
    serviceUrl: registryServiceUrl,
    apiAuthToken: firstNonEmpty(process.env.REGISTRY_API_AUTH_TOKEN, process.env.API_AUTH_TOKEN),
    heartbeatIntervalMs: mustNumber("WRITER_ADVERTISE_INTERVAL_MS", 30000),
    ttlSeconds: mustNumber("WRITER_ADVERTISE_TTL_SECONDS", 120)
  },
  identity: {
    agentId:
      profileEnv("AGENT_ID")?.trim() ||
      process.env.SERVICE_AGENT_ID?.trim() ||
      (genericProfile ? process.env.WRITER_AGENT_ID?.trim() : undefined) ||
      undefined,
    name:
      profileEnv("AGENT_NAME") ??
      process.env.SERVICE_AGENT_NAME ??
      (genericProfile ? process.env.WRITER_AGENT_NAME : undefined) ??
      `Agora ${serviceProfile === "all" ? "Service Host" : serviceProfile}`,
    description:
      profileEnv("AGENT_DESCRIPTION") ??
      process.env.SERVICE_AGENT_DESCRIPTION ??
      (genericProfile ? process.env.WRITER_AGENT_DESCRIPTION : undefined) ??
      "Autonomous service agent that sells paid specialist capabilities.",
    image: process.env.WRITER_AGENT_IMAGE,
    trustModels: parseCsv(process.env.WRITER_TRUST_MODELS, ["reputation", "crypto-economic"]),
    onchain: {
      enabled: parseBoolean(process.env.WRITER_REGISTER_ONCHAIN, false),
      registryAddress: process.env.IDENTITY_REGISTRY_ADDRESS,
      agentUri: process.env.WRITER_AGENT_URI ?? `${publicEndpoint}/identity`,
      wallet: {
        enabled: parseBoolean(process.env.WRITER_SET_AGENT_WALLET_ONCHAIN, false),
        address:
          normalizeAddress(process.env.WRITER_AGENT_WALLET_ADDRESS) ??
          normalizeAddress(process.env.IDENTITY_AGENT_WALLET_ADDRESS) ??
          writerAddress,
        signerPrivateKey:
          normalizePrivateKey(process.env.WRITER_AGENT_WALLET_SIGNER_PRIVATE_KEY) ??
          normalizePrivateKey(process.env.IDENTITY_AGENT_WALLET_SIGNER_PRIVATE_KEY),
        deadlineSeconds: mustNumber("IDENTITY_SET_WALLET_DEADLINE_SECONDS", 300),
        signature: {
          domainName: firstNonEmpty(
            process.env.IDENTITY_SET_WALLET_DOMAIN_NAME,
            "ERC-8004 IdentityRegistry"
          )!,
          domainVersion: firstNonEmpty(process.env.IDENTITY_SET_WALLET_DOMAIN_VERSION, "1.1")!,
          typeName: firstNonEmpty(process.env.IDENTITY_SET_WALLET_TYPE_NAME, "SetAgentWallet")!,
          includeOwner: parseBoolean(process.env.IDENTITY_SET_WALLET_INCLUDE_OWNER, false),
          allowLegacyFallback: parseBoolean(process.env.IDENTITY_SET_WALLET_ALLOW_LEGACY_FALLBACK, true)
        }
      }
    }
  },
  reputation: {
    onchain: {
      enabled: parseBoolean(process.env.WRITER_READ_ONCHAIN_REPUTATION, false),
      registryAddress: process.env.REPUTATION_REGISTRY_ADDRESS
    }
  }
};
