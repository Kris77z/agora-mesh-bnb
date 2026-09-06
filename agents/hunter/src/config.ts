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

function mustIntegerInRange(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = mustNumber(name, fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid integer env: ${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizePrivateKey(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === "" || raw === "0x...") {
    return undefined;
  }
  try {
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === "true";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

const explicitPrivateKey = normalizePrivateKey(process.env.HUNTER_PRIVATE_KEY);
const hunterSignerAddress = explicitPrivateKey ? new ethers.Wallet(explicitPrivateKey).address : undefined;
const kimiApiKey = normalizeApiKey(process.env.KIMI_API_KEY);
const openaiApiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
const llmProvider = kimiApiKey ? "kimi" : openaiApiKey ? "openai" : "none";
const port = mustNumber("HUNTER_PORT", 3002);
const publicEndpoint = process.env.HUNTER_PUBLIC_ENDPOINT ?? `http://localhost:${port}`;
const registryServiceUrl = process.env.REGISTRY_SERVICE_URL ?? "http://localhost:3003";
const chain = resolveChainConfig({
  preset: process.env.CHAIN_PRESET,
  chainId: process.env.CHAIN_ID,
  rpcUrl:
    process.env.RPC_URL ??
    (process.env.CHAIN_PRESET === "monad-testnet" ? process.env.MONAD_RPC_URL : undefined)
});
const altanaEnabled = parseBoolean(process.env.ALTANA_ENABLED, false);
const x402Rail: "eip3009" | "permit2" =
  process.env.X402_RAIL === "eip3009" ? "eip3009" : "permit2";

export const hunterConfig = {
  port,
  chain,
  chainId: chain.chainId,
  rpcUrl: chain.rpcUrl,
  privateKey: explicitPrivateKey,
  registryPath: path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.REGISTRY_PATH ?? "./registry/services.json"
  ),
  llm: {
    provider: llmProvider,
    apiKey: llmProvider === "kimi" ? kimiApiKey : llmProvider === "openai" ? openaiApiKey : undefined,
    model: llmProvider === "kimi" ? process.env.KIMI_MODEL ?? "kimi-k2.5" : process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseURL:
      llmProvider === "kimi"
        ? process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1"
        : process.env.OPENAI_BASE_URL
  },
  defaultGoal:
    "Find a security auditor and audit a BNB Smart Chain contract.",
  useReact: process.env.HUNTER_USE_REACT === "true",
  isMockMode: !explicitPrivateKey,
  persistence: readStoreBackendConfig(),
  httpSecurity: {
    allowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, ["http://localhost:3000"]),
    apiAuthToken: firstNonEmpty(process.env.HUNTER_API_AUTH_TOKEN, process.env.API_AUTH_TOKEN),
    rateLimitPerMinute: mustIntegerInRange("HUNTER_RATE_LIMIT_PER_MINUTE", 120, 1, 10_000),
    production: process.env.NODE_ENV === "production"
  },
  publicEndpoint,
  registryServiceUrl,
  discoveryEndpoints: parseCsv(process.env.DYNAMIC_AGENT_ENDPOINTS, []),
  discoverySecurity: {
    allowLocalEndpoints: parseBoolean(
      process.env.HUNTER_ALLOW_LOCAL_SERVICE_ENDPOINTS,
      process.env.NODE_ENV !== "production"
    ),
    allowedHosts: parseCsv(process.env.HUNTER_ALLOWED_SERVICE_HOSTS, [])
  },
  missionStorePath: path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.HUNTER_MISSION_STORE_PATH ?? "./registry/missions.json"
  ),
  runStorePath: path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.HUNTER_RUN_STORE_PATH ?? "./registry/runs.json"
  ),
  advantage: {
    auditGroundTruthPath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_AUDIT_GROUND_TRUTH_PATH ??
        "./evidence/experiment-1-contract-audit/ground-truth.json"
    ),
    auditToolBaselinePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_AUDIT_TOOL_BASELINE_PATH ??
        "./evidence/experiment-1-contract-audit/tool-baseline-output.json"
    ),
    tokenRiskSecurityReviewPath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_TOKEN_RISK_SECURITY_REVIEW_PATH ??
        "./evidence/experiment-2-token-risk/security-review-output.json"
    ),
    tokenRiskEnrichmentPath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_TOKEN_RISK_ENRICHMENT_PATH ??
        "./evidence/experiment-2-token-risk/indexed-enrichment-output.json"
    ),
    dueDiligenceCandidatePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_DUE_DILIGENCE_CANDIDATE_PATH ??
        "./evidence/experiment-3-due-diligence/candidate-output.json"
    ),
    paidDueDiligencePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_PAID_DUE_DILIGENCE_PATH ??
        "./evidence/experiment-3-due-diligence/paid-run-final-output.json"
    ),
    comparisonBundlePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_COMPARISON_BUNDLE_PATH ??
        "./evidence/agent-advantage-report.json"
    ),
    auditModelCandidatePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_AUDIT_MODEL_CANDIDATE_PATH ??
        "./evidence/experiment-1-contract-audit/baseline-output-candidate.json"
    ),
    tokenRiskModelCandidatePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_TOKEN_RISK_MODEL_CANDIDATE_PATH ??
        "./evidence/experiment-2-token-risk/baseline-output-candidate.json"
    ),
    dueDiligenceModelCandidatePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_DUE_DILIGENCE_MODEL_CANDIDATE_PATH ??
        "./evidence/experiment-3-due-diligence/baseline-output-candidate-attempt-2.json"
    ),
    dueDiligenceModelSlitherPath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ADVANTAGE_DUE_DILIGENCE_MODEL_SLITHER_PATH ??
        "./evidence/experiment-3-due-diligence/baseline-slither-output-attempt-2.json"
    )
  },
  altana: {
    enabled: altanaEnabled,
    walletAddress: normalizeAddress(process.env.ALTANA_WALLET_ADDRESS),
    authorityId: process.env.ALTANA_AUTHORITY_ID?.trim() || undefined,
    sessionStorePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ALTANA_SESSION_STORE_PATH ?? "./registry/altana-sessions.json"
    ),
    authorityEvidencePath: path.resolve(
      process.env.INIT_CWD ?? process.cwd(),
      process.env.ALTANA_AUTHORITY_EVIDENCE_PATH ?? "./registry/authority-evidence.json"
    ),
    paymentEvidencePaths: parseCsv(process.env.ALTANA_PAYMENT_EVIDENCE_PATHS, [
      "./registry/x402-auditor-receipts.json",
      "./registry/x402-verifier-receipts.json",
      "./registry/x402-investigator-receipts.json",
      "./registry/x402-sentinel-receipts.json"
    ]).map((entry) => path.resolve(process.env.INIT_CWD ?? process.cwd(), entry)),
    sessionEncryptionKey: normalizeApiKey(process.env.ALTANA_SESSION_ENCRYPTION_KEY)
  },
  x402: {
    enabled: parseBoolean(process.env.X402_ENABLED, false),
    purchaseStorePath: path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.X402_PURCHASE_STORE_PATH ?? "./registry/x402-purchases"),
    preferRail: x402Rail,
    deliveryAttempts: mustIntegerInRange("X402_DELIVERY_ATTEMPTS", 2, 1, 3)
  },
  securitySource: {
    etherscanApiKey: normalizeApiKey(
      process.env.ETHERSCAN_API_KEY ?? process.env.BSCSCAN_API_KEY
    ),
    timeoutMs: mustNumber("SECURITY_SOURCE_TIMEOUT_MS", 10_000),
    maxSourceBytes: mustNumber("SECURITY_MAX_SOURCE_BYTES", 512_000),
    httpBodyLimit: process.env.SECURITY_HTTP_BODY_LIMIT?.trim() || "3mb"
  },
  identity: {
    agentId: process.env.HUNTER_AGENT_ID || undefined,
    name: process.env.HUNTER_AGENT_NAME ?? "Agora Agent",
    description:
      process.env.HUNTER_AGENT_DESCRIPTION ??
      "Autonomous AI agent — discovers services, negotiates payment, and verifies results.",
    image: process.env.HUNTER_AGENT_IMAGE,
    trustModels: parseCsv(process.env.HUNTER_TRUST_MODELS, ["reputation", "crypto-economic"]),
    onchain: {
      enabled: parseBoolean(process.env.HUNTER_REGISTER_ONCHAIN, false),
      registryAddress: process.env.IDENTITY_REGISTRY_ADDRESS,
      ownerAddress: normalizeAddress(process.env.HUNTER_ONCHAIN_OWNER_ADDRESS) ?? hunterSignerAddress,
      agentUri: process.env.HUNTER_AGENT_URI ?? `${publicEndpoint}/agent-registration.json`,
      wallet: {
        enabled: parseBoolean(process.env.HUNTER_SET_AGENT_WALLET_ONCHAIN, false),
        address:
          normalizeAddress(process.env.HUNTER_AGENT_WALLET_ADDRESS) ??
          normalizeAddress(process.env.IDENTITY_AGENT_WALLET_ADDRESS) ??
          hunterSignerAddress,
        signerPrivateKey:
          normalizePrivateKey(process.env.HUNTER_AGENT_WALLET_SIGNER_PRIVATE_KEY) ??
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
      enabled: parseBoolean(process.env.HUNTER_SUBMIT_ONCHAIN_FEEDBACK, false),
      registryAddress: process.env.REPUTATION_REGISTRY_ADDRESS,
      tag1: process.env.HUNTER_FEEDBACK_TAG1 ?? "quality",
      tag2: process.env.HUNTER_FEEDBACK_TAG2 ?? "delivery"
    }
  }
};
