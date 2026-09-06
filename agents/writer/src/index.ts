import express from "express";
import { readFile } from "node:fs/promises";
import {
  apiTokenMatches,
  closeProcessPostgresStores,
  FixedWindowRateLimiter,
  getFeedbackStoreReputation,
  getProcessPostgresStore,
  isAllowedCorsOrigin,
  listFeedbackStoreEntries,
  normalizeRequestId
} from "@rebel/shared";
import { writerConfig } from "./config.js";
import { advertiseWriterCapabilities, getWriterAdvertiseStatus } from "./advertise.js";
import { getWriterIdentity, getWriterServiceInfo, getWriterServicesInfo } from "./identity.js";
import { getWriterOnchainReputation } from "./onchain-reputation.js";
import {
  getWriterOnChainRegistrationStatus,
  registerWriterIdentityOnChain
} from "./onchain-registration.js";
import { executeHandler } from "./routes.js";
import { x402ExecuteHandler } from "./x402/routes.js";
import { getSlitherStatus } from "./verification/slither-status.js";

const app = express();
const postgresStore = await getProcessPostgresStore(`agora-writer-${writerConfig.serviceProfile}`);

const requestLimiter = new FixedWindowRateLimiter(writerConfig.httpSecurity.rateLimitPerMinute, 60_000);

app.use((req, res, next) => {
  const requestId = normalizeRequestId(req.get("x-request-id"));
  const started = performance.now();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => console.log(JSON.stringify({
    requestId,
    method: req.method,
    path: req.path,
    status: res.statusCode,
    durationMs: Number((performance.now() - started).toFixed(3)),
    service: writerConfig.serviceProfile
  })));
  const origin = req.get("origin");
  if (!isAllowedCorsOrigin(origin, writerConfig.httpSecurity.allowedOrigins)) {
    res.status(403).json({ code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key, X-Agora-Token, X-PAYMENT, PAYMENT-SIGNATURE, X-Request-Id"
  );
  res.setHeader("Access-Control-Expose-Headers", "X-Payment-Transaction, X-Request-Hash, X-Request-Id, Retry-After");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const rate = requestLimiter.consume(req.ip || req.socket.remoteAddress || "unknown");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1_000))));
    res.status(429).json({ code: "RATE_LIMITED", message: "Too many requests" });
    return;
  }
  next();
});

function requireLegacyExecuteAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const expected = writerConfig.httpSecurity.apiAuthToken;
  if (!expected) {
    if (writerConfig.httpSecurity.production) {
      res.status(503).json({ code: "API_AUTH_NOT_CONFIGURED", message: "Legacy execute authentication is required in production" });
      return;
    }
    next();
    return;
  }
  const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!apiTokenMatches(expected, bearer ?? req.get("x-agora-token"))) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "A valid API token is required" });
    return;
  }
  next();
}

app.use(express.json({ limit: writerConfig.httpBodyLimit }));
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 413) {
    res.status(413).json({
      code: "SECURITY_PAYLOAD_TOO_LARGE",
      message: "Request body exceeds SECURITY_HTTP_BODY_LIMIT"
    });
    return;
  }
  next(error);
});

app.post("/execute", requireLegacyExecuteAuth, (req, res) => {
  void executeHandler(req, res);
});

app.post("/execute/x402", (req, res) => {
  void x402ExecuteHandler(req, res);
});

async function readLastSuccessfulTransaction(): Promise<{ transaction: string; timestamp: number } | undefined> {
  if (postgresStore) {
    return postgresStore.latestConfirmedX402Payment(
      getWriterServicesInfo().map((service) => service.id)
    );
  }
  try {
    const parsed = JSON.parse(await readFile(writerConfig.x402.receiptStorePath, "utf8")) as {
      records?: Record<string, { payment?: { transaction?: unknown }; updatedAt?: unknown }>;
    };
    return Object.values(parsed.records ?? {}).reduce<{ transaction: string; timestamp: number } | undefined>(
      (latest, record) => {
        const transaction = record.payment?.transaction;
        const timestamp = record.updatedAt;
        if (typeof transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transaction) ||
          typeof timestamp !== "number") return latest;
        return !latest || timestamp > latest.timestamp ? { transaction, timestamp } : latest;
      },
      undefined
    );
  } catch {
    return undefined;
  }
}

app.get("/health", async (_req, res) => {
  const slither = writerConfig.serviceProfile === "verifier" ? getSlitherStatus() : undefined;
  const slitherIntegrated = true;
  const services = getWriterServicesInfo();
  const unavailableServices = services
    .filter((service) => service.availability?.available === false)
    .map((service) => ({ id: service.id, reason: service.availability?.reason }));
  const investigator = writerConfig.serviceProfile === "investigator"
    ? {
        mode: "rpc-read-only",
        endpoint: (() => {
          try {
            const url = new URL(writerConfig.rpcUrl);
            return `${url.protocol}//${url.host}`;
          } catch {
            return "configured-rpc";
          }
        })()
      }
    : undefined;
  const lastSuccessfulTestnetTx = await readLastSuccessfulTransaction();
  const registryHeartbeat = getWriterAdvertiseStatus();
  const persistenceAvailable = postgresStore
    ? await postgresStore.pool.query("SELECT 1").then(() => true).catch(() => false)
    : true;
  res.status(200).json({
    status:
      (slither && !slither.available) || unavailableServices.length > 0 || !persistenceAvailable
        ? "degraded"
        : "ok",
    service: writerConfig.serviceProfile === "all" ? "service-host" : writerConfig.serviceProfile,
    profile: writerConfig.serviceProfile,
    chainId: writerConfig.chainId,
    writerAddress: writerConfig.writerAddress,
    walletAddress: writerConfig.writerAddress,
    paymentRail: writerConfig.x402.enabled ? `x402:${writerConfig.x402.rail}` : "legacy",
    registryHeartbeat,
    llm: {
      provider: writerConfig.llm.provider,
      available: writerConfig.llm.provider !== "none"
    },
    lastSuccessfulTestnetTx,
    persistence: { backend: writerConfig.persistence.backend, available: persistenceAvailable },
    serviceCount: services.length,
    availableServiceCount: services.length - unavailableServices.length,
    unavailableServices,
    agentId: getWriterIdentity().agentId,
    ...(slither
      ? {
          slither: { ...slither, integrated: slitherIntegrated },
          deterministicFallback: "agora-solidity-rules@1"
        }
      : {}),
    ...(unavailableServices.length > 0
      ? { model: { available: false, reason: "One or more service runtimes are unavailable" } }
      : {}),
    ...(investigator ? { investigator } : {})
  });
});

app.get("/identity", async (_req, res) => {
  try {
    const onchain = await getWriterOnChainRegistrationStatus();
    res.status(200).json({
      identity: getWriterIdentity(),
      service: getWriterServiceInfo(),
      services: getWriterServicesInfo(),
      onchain
    });
  } catch (error) {
    res.status(500).json({
      code: "IDENTITY_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load identity"
    });
  }
});

app.get("/feedback", async (_req, res) => {
  try {
    const identity = getWriterIdentity();
    const entries = await listFeedbackStoreEntries(identity.agentId);
    res.status(200).json({
      agentId: identity.agentId,
      count: entries.length,
      feedback: entries
    });
  } catch (error) {
    res.status(500).json({
      code: "FEEDBACK_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load feedback"
    });
  }
});

app.get("/feedback/:agentId", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const entries = await listFeedbackStoreEntries(agentId);
    res.status(200).json({
      agentId,
      count: entries.length,
      feedback: entries
    });
  } catch (error) {
    res.status(500).json({
      code: "FEEDBACK_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load feedback"
    });
  }
});

app.get("/reputation", async (_req, res) => {
  try {
    const identity = getWriterIdentity();
    const [reputation, onchain] = await Promise.all([
      getFeedbackStoreReputation(identity.agentId),
      getWriterOnchainReputation().catch(() => ({
        enabled: writerConfig.reputation.onchain.enabled,
        available: false as const,
        reason: "onchain read failed"
      }))
    ]);
    res.status(200).json({
      agentId: identity.agentId,
      ...reputation,
      onchain
    });
  } catch (error) {
    res.status(500).json({
      code: "REPUTATION_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load reputation"
    });
  }
});

app.get("/reputation/:agentId", async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const reputation = await getFeedbackStoreReputation(agentId);
    res.status(200).json({
      agentId,
      ...reputation
    });
  } catch (error) {
    res.status(500).json({
      code: "REPUTATION_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load reputation"
    });
  }
});

const server = app.listen(writerConfig.port, () => {
  void advertiseWriterCapabilities().catch((error) => {
    console.error(
      `[writer] capability advertise failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const heartbeat = setInterval(() => {
    void advertiseWriterCapabilities({ silent: true });
  }, writerConfig.discovery.heartbeatIntervalMs);
  heartbeat.unref?.();
  void registerWriterIdentityOnChain();
  console.log(
    `[writer] running on :${writerConfig.port} | mode=${writerConfig.isMockMode ? "mock" : "chain"} | llm=${writerConfig.llm.provider}:${writerConfig.llm.model} | store=${writerConfig.persistence.backend}`
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await closeProcessPostgresStores().catch(() => undefined);
  });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
