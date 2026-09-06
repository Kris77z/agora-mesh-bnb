import express from "express";
import {
  appendServiceFeedbackEntry,
  closeProcessPostgresStores,
  getServiceReputation,
  registerDynamicService,
  getPersistedAgentIdentity,
  listPersistedAgentIdentities,
  persistAgentIdentity,
  apiTokenMatches,
  assertSafeServiceEndpoint,
  FixedWindowRateLimiter,
  getProcessPostgresStore,
  isAllowedCorsOrigin,
  normalizeRequestId,
  type ServiceInfo,
  type AgentIdentity
} from "@rebel/shared";
import { registryConfig } from "./config.js";
import { compareCatalogServices, loadCatalogServices } from "./catalog.js";

const app = express();
const postgresStore = await getProcessPostgresStore("agora-registry");

const requestLimiter = new FixedWindowRateLimiter(registryConfig.httpSecurity.rateLimitPerMinute, 60_000);

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
    service: "registry"
  })));
  const origin = req.get("origin");
  if (!isAllowedCorsOrigin(origin, registryConfig.httpSecurity.allowedOrigins)) {
    res.status(403).json({ code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Agora-Token, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");
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

app.use(express.json({ limit: registryConfig.httpBodyLimit }));
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 413) {
    res.status(413).json({ code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds REGISTRY_HTTP_BODY_LIMIT" });
    return;
  }
  next(error);
});

function requireRegistryWriteAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const expected = registryConfig.httpSecurity.apiAuthToken;
  if (!expected) {
    if (registryConfig.httpSecurity.production) {
      res.status(503).json({ code: "API_AUTH_NOT_CONFIGURED", message: "Registry write authentication is required in production" });
      return;
    }
    next();
    return;
  }
  const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!apiTokenMatches(expected, bearer ?? req.get("x-agora-token"))) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "A valid registry write token is required" });
    return;
  }
  next();
}

app.get("/health", async (_req, res) => {
  const persistenceAvailable = postgresStore
    ? await postgresStore.pool.query("SELECT 1").then(() => true).catch(() => false)
    : true;
  res.status(200).json({
    status: persistenceAvailable ? "ok" : "degraded",
    service: "registry",
    agentId: null,
    chainId: registryConfig.chainId,
    paymentRail: "none",
    walletAddress: null,
    registryHeartbeat: { status: "self" },
    llm: { provider: "none", available: false, reason: "not applicable" },
    lastSuccessfulTestnetTx: null,
    persistence: { backend: registryConfig.persistence.backend, available: persistenceAvailable }
  });
});

/* ─── Service endpoints ─── */

app.get("/services", async (req, res) => {
  try {
    const rawChainId = typeof req.query.chainId === "string" ? Number(req.query.chainId) : undefined;
    if (rawChainId !== undefined && (!Number.isInteger(rawChainId) || rawChainId <= 0)) {
      res.status(400).json({ code: "INVALID_CHAIN_ID", message: "chainId must be a positive integer" });
      return;
    }
    const services = await loadCatalogServices({
      category: typeof req.query.category === "string" ? req.query.category : undefined,
      rail: typeof req.query.rail === "string" ? req.query.rail : undefined,
      chainId: rawChainId
    });
    res.status(200).json({ services, count: services.length });
  } catch (error) {
    res.status(500).json({
      code: "REGISTRY_LIST_FAILED",
      message: error instanceof Error ? error.message : "Failed to list services"
    });
  }
});

app.get("/services/:serviceId", async (req, res) => {
  try {
    const services = await loadCatalogServices();
    const service = services.find((item) => item.id === req.params.serviceId);
    if (!service) {
      res.status(404).json({ code: "SERVICE_NOT_FOUND", message: `Service not found: ${req.params.serviceId}` });
      return;
    }
    res.status(200).json({ service });
  } catch (error) {
    res.status(500).json({
      code: "REGISTRY_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to read service"
    });
  }
});

app.post("/services/compare", async (req, res) => {
  try {
    const body = req.body as { serviceIds?: unknown; taskType?: unknown; requiredSkills?: unknown } | undefined;
    if (body?.serviceIds !== undefined &&
      (!Array.isArray(body.serviceIds) || body.serviceIds.some((item) => typeof item !== "string"))) {
      res.status(400).json({ code: "INVALID_PAYLOAD", message: "serviceIds must be a string array" });
      return;
    }
    if (body?.requiredSkills !== undefined &&
      (!Array.isArray(body.requiredSkills) || body.requiredSkills.some((item) => typeof item !== "string"))) {
      res.status(400).json({ code: "INVALID_PAYLOAD", message: "requiredSkills must be a string array" });
      return;
    }
    const rankings = await compareCatalogServices({
      serviceIds: body?.serviceIds as string[] | undefined,
      taskType: typeof body?.taskType === "string" ? body.taskType : undefined,
      requiredSkills: body?.requiredSkills as string[] | undefined
    });
    res.status(200).json({ rankings, count: rankings.length, policy: {
      chainId: registryConfig.chainId, paymentRail: registryConfig.x402Enabled ? "x402" : "legacy-native",
      liveIdentityRequired: registryConfig.x402Enabled
    } });
  } catch (error) {
    res.status(500).json({
      code: "SERVICE_COMPARE_FAILED",
      message: error instanceof Error ? error.message : "Failed to compare services"
    });
  }
});

app.post("/services/register", requireRegistryWriteAuth, async (req, res) => {
  try {
    const body = req.body as {
      agentId?: string;
      service?: ServiceInfo;
      ttlSeconds?: number;
    };

    if (!body?.agentId || !body?.service) {
      res.status(400).json({
        code: "INVALID_PAYLOAD",
        message: "agentId and service are required"
      });
      return;
    }

    await assertSafeServiceEndpoint(body.service.endpoint, {
      allowLocal: registryConfig.httpSecurity.allowLocalServiceEndpoints,
      allowedHosts: registryConfig.httpSecurity.allowedServiceHosts
    });

    await registerDynamicService({
      agentId: body.agentId,
      service: body.service,
      ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined
    });

    res.status(200).json({
      status: "ok",
      serviceId: body.service.id
    });
  } catch (error) {
    res.status(500).json({
      code: "REGISTRY_REGISTER_FAILED",
      message: error instanceof Error ? error.message : "Failed to register service"
    });
  }
});

app.post("/services/:serviceId/feedback", requireRegistryWriteAuth, async (req, res) => {
  try {
    const serviceId = req.params.serviceId?.trim();
    const body = req.body as {
      hunterId?: string;
      missionId?: string;
      score?: number;
      taskType?: string;
      comment?: string;
      timestamp?: number;
    };

    if (!serviceId) {
      res.status(400).json({
        code: "INVALID_SERVICE_ID",
        message: "serviceId is required"
      });
      return;
    }

    if (
      !body?.hunterId ||
      !body?.missionId ||
      typeof body.score !== "number" ||
      !Number.isFinite(body.score)
    ) {
      res.status(400).json({
        code: "INVALID_PAYLOAD",
        message: "hunterId, missionId and numeric score are required"
      });
      return;
    }

    const services = await loadCatalogServices();
    const serviceExists = services.some((item) => item.id === serviceId);
    if (!serviceExists) {
      res.status(404).json({
        code: "SERVICE_NOT_FOUND",
        message: `Service not found: ${serviceId}`
      });
      return;
    }

    const entry = await appendServiceFeedbackEntry({
      serviceId,
      hunterId: body.hunterId,
      missionId: body.missionId,
      score: body.score,
      taskType: body.taskType ?? "unknown",
      comment: body.comment,
      timestamp: typeof body.timestamp === "number" ? body.timestamp : undefined
    });
    const reputation = await getServiceReputation(serviceId);

    res.status(200).json({
      status: "ok",
      serviceId,
      feedback: entry,
      reputation
    });
  } catch (error) {
    res.status(500).json({
      code: "SERVICE_FEEDBACK_FAILED",
      message: error instanceof Error ? error.message : "Failed to submit service feedback"
    });
  }
});

/* ─── Agent identity endpoints ─── */

app.post("/agents/register", requireRegistryWriteAuth, async (req, res) => {
  try {
    const body = req.body as Partial<AgentIdentity> | undefined;

    if (!body?.name?.trim() || !body?.walletAddress?.trim()) {
      res.status(400).json({
        code: "INVALID_PAYLOAD",
        message: "name and walletAddress are required"
      });
      return;
    }

    const agentId = body.agentId ?? `user:${body.walletAddress.toLowerCase()}`;
    const existing = await getPersistedAgentIdentity(agentId);
    const identity: AgentIdentity = {
      agentId,
      name: body.name.trim(),
      description: body.description?.trim() ?? "",
      image: body.image,
      walletAddress: body.walletAddress,
      capabilities: body.capabilities ?? [],
      trustModels: body.trustModels ?? ["reputation"],
      active: true,
      registeredAt: existing?.registeredAt ?? Math.floor(Date.now() / 1000)
    };

    const registered = await persistAgentIdentity(identity);
    res.status(200).json({ status: "ok", identity: registered });
  } catch (error) {
    res.status(500).json({
      code: "AGENT_REGISTER_FAILED",
      message: error instanceof Error ? error.message : "Failed to register agent"
    });
  }
});

app.get("/agents", async (_req, res) => {
  try {
    const activeOnly = _req.query.active === "true";
    const agents = await listPersistedAgentIdentities({ activeOnly });
    res.status(200).json({ agents, count: agents.length });
  } catch (error) {
    res.status(500).json({
      code: "AGENT_LIST_FAILED",
      message: error instanceof Error ? error.message : "Failed to list agents"
    });
  }
});

app.get("/agents/:agentId/reputation", async (req, res) => {
  try {
    const services = (await loadCatalogServices()).filter((service) => service.agentId === req.params.agentId);
    if (services.length === 0) {
      res.status(404).json({ code: "AGENT_NOT_FOUND", message: `Agent not found: ${req.params.agentId}` });
      return;
    }
    res.status(200).json({
      agentId: req.params.agentId,
      services: services.map((service) => ({ serviceId: service.id, reputation: service.reputation }))
    });
  } catch (error) {
    res.status(500).json({ code: "AGENT_READ_FAILED", message: error instanceof Error ? error.message : "Failed to read agent" });
  }
});

app.get("/agents/:agentId", async (req, res) => {
  try {
    const registered = await getPersistedAgentIdentity(req.params.agentId);
    const services = (await loadCatalogServices()).filter((service) => service.agentId === req.params.agentId);
    if (!registered && services.length === 0) {
      res.status(404).json({ code: "AGENT_NOT_FOUND", message: `Agent not found: ${req.params.agentId}` });
      return;
    }
    const primary = services[0];
    const identity = registered ?? {
      agentId: req.params.agentId,
      name: primary?.name ?? req.params.agentId,
      description: primary?.description ?? "Service provider in Agora Mesh",
      walletAddress: primary?.provider ?? "",
      capabilities: services.map((service) => ({
        type: "a2a" as const,
        endpoint: service.endpoint,
        skills: service.skills
      })),
      trustModels: ["reputation", "receipt"],
      active: true,
      registeredAt: 0
    };
    res.status(200).json({ identity, services });
  } catch (error) {
    res.status(500).json({ code: "AGENT_READ_FAILED", message: error instanceof Error ? error.message : "Failed to read agent" });
  }
});

const server = app.listen(registryConfig.port, () => {
  console.log(`[registry] running on :${registryConfig.port} | store=${registryConfig.persistence.backend}`);
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
