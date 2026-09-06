import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { readStoreBackendConfig } from "@rebel/shared";

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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  return raw === undefined ? fallback : raw === "true";
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return values.length > 0 ? values : fallback;
}

export const registryConfig = {
  port: mustNumber("REGISTRY_PORT", 3003),
  chainId: mustNumber("CHAIN_ID", 97),
  x402Enabled: parseBoolean(process.env.X402_ENABLED, false),
  persistence: readStoreBackendConfig(),
  httpBodyLimit: process.env.REGISTRY_HTTP_BODY_LIMIT?.trim() || "512kb",
  httpSecurity: {
    allowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, ["http://localhost:3000"]),
    apiAuthToken: process.env.REGISTRY_API_AUTH_TOKEN?.trim() || process.env.API_AUTH_TOKEN?.trim() || undefined,
    rateLimitPerMinute: mustNumber("REGISTRY_RATE_LIMIT_PER_MINUTE", 240),
    production: process.env.NODE_ENV === "production",
    allowLocalServiceEndpoints: parseBoolean(
      process.env.REGISTRY_ALLOW_LOCAL_SERVICE_ENDPOINTS,
      process.env.NODE_ENV !== "production"
    ),
    allowedServiceHosts: parseCsv(process.env.REGISTRY_ALLOWED_SERVICE_HOSTS, [])
  },
  registryPath: path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.REGISTRY_PATH ?? "./registry/services.json"
  )
};
