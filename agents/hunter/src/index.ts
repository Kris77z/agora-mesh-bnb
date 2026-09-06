import express from "express";
import { browserAuthorityRouter } from './integrations/altana/browser-authority.js';
import { readFile } from "node:fs/promises";
import {
  apiTokenMatches,
  closeProcessPostgresStores,
  DEFAULT_LANGUAGE_CODE,
  FixedWindowRateLimiter,
  getProcessPostgresStore,
  isAllowedCorsOrigin,
  normalizeRequestId
} from "@rebel/shared";
import type { ErrorResponse, HunterRunRequest, HunterRunRequestMode, LanguageCode } from "@rebel/shared";
import { hunterConfig } from "./config.js";
import { localizeHunterError } from "./error-messages.js";
import { HunterError, asHunterError } from "./errors.js";
import { getHunterIdentity } from "./identity.js";
import {
  getHunterOnChainRegistrationStatus,
  registerHunterIdentityOnChain
} from "./onchain-registration.js";
import { runHunter, type HunterTraceEvent } from "./react-engine.js";
import { checkHunterBalance, getHunterAddress } from "./wallet.js";
import { loadAltanaAuthority } from "./integrations/altana/authority.js";
import {
  FileAuthorityEvidenceStore,
  PostgresAuthorityEvidenceStore,
  type AuthorityEvidenceStore
} from "./integrations/altana/authority-evidence-store.js";
import { readAuthoritySpending } from "./integrations/altana/authority-spending.js";
import { hunterError as logHunterError } from "./logger.js";
import { recoverMissionFromEvidence } from "./mission-recovery.js";
import { buildAdvantageReport } from "./advantage-report.js";
import {
  loadAuditGroundTruth,
  loadAuditToolBaseline,
  loadAdvantageComparisonBundle,
  loadModelOnlyBaselineCandidate,
  loadPaidDueDiligence,
  loadTokenRiskEnrichment,
  loadTokenRiskSecurityReview
} from "./advantage-evaluator.js";
import { loadDueDiligenceCandidate } from "./due-diligence.js";
import {
  FileHunterMissionStore,
  PostgresHunterMissionStore,
  type HunterMissionStore,
  type StoredHunterMission
} from "./mission-store.js";
import { HunterRunManager } from "./run-manager.js";
import {
  FileHunterRunStore,
  PostgresHunterRunStore,
  publicRunRecord,
  validateRunIdempotencyKey,
  type HunterRunStore
} from "./run-store.js";
import { buildErc8004RegistrationFile } from "./erc8004-registration.js";

const app = express();
const postgresStore = await getProcessPostgresStore("agora-hunter");
const missionStore: HunterMissionStore = postgresStore
  ? new PostgresHunterMissionStore(postgresStore)
  : new FileHunterMissionStore(hunterConfig.missionStorePath);
const runStore: HunterRunStore = postgresStore
  ? new PostgresHunterRunStore(postgresStore)
  : new FileHunterRunStore(hunterConfig.runStorePath);
const authorityEvidenceStore: AuthorityEvidenceStore = postgresStore
  ? new PostgresAuthorityEvidenceStore(postgresStore)
  : new FileAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);

const requestLimiter = new FixedWindowRateLimiter(hunterConfig.httpSecurity.rateLimitPerMinute, 60_000);

app.use((req, res, next) => {
  const requestId = normalizeRequestId(req.get("x-request-id"));
  const started = performance.now();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    console.log(JSON.stringify({
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number((performance.now() - started).toFixed(3)),
      service: "hunter"
    }));
  });

  const origin = req.get("origin");
  if (!isAllowedCorsOrigin(origin, hunterConfig.httpSecurity.allowedOrigins)) {
    res.status(403).json({ code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-Agora-Token, X-Authority-Token, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Mission-Id, X-Request-Id, Retry-After");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const rate = requestLimiter.consume(req.ip || req.socket.remoteAddress || "unknown");
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1_000))));
    res.status(429).json({ code: "RATE_LIMITED", message: "Too many requests" });
    return;
  }
  next();
});

function requireApiAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const expected = hunterConfig.httpSecurity.apiAuthToken;
  if (!expected) {
    if (hunterConfig.httpSecurity.production) {
      res.status(503).json({ code: "API_AUTH_NOT_CONFIGURED", message: "API authentication is required in production" });
      return;
    }
    next();
    return;
  }
  const authorization = req.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = req.get("x-agora-token");
  const sseQueryToken = req.method === "GET" && req.path === "/run/stream" &&
    typeof req.query.demoToken === "string" ? req.query.demoToken : undefined;
  if (!apiTokenMatches(expected, bearer ?? headerToken ?? sseQueryToken)) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "A valid API or demo token is required" });
    return;
  }
  next();
}

app.use(express.json({ limit: hunterConfig.securitySource.httpBodyLimit }));
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

function writeSseEvent(
  res: express.Response,
  event: "trace" | "done" | "error" | "ready",
  payload: unknown,
  id?: string
): void {
  if (id) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseRunMode(raw: unknown): HunterRunRequestMode {
  return raw === "commander" ? "commander" : "single";
}

function parseLocale(raw: unknown): LanguageCode {
  return raw === "zh-CN" ? "zh-CN" : DEFAULT_LANGUAGE_CODE;
}

function readRunMode(
  events: HunterTraceEvent[],
  requestMode: HunterRunRequestMode
): StoredHunterMission["mode"] {
  const started = events.find((event) => event.type === "run_started");
  if (started?.data && typeof started.data === "object") {
    const mode = (started.data as { mode?: unknown }).mode;
    if (mode === "scripted" || mode === "react" || mode === "commander") return mode;
  }
  return requestMode === "commander"
    ? "commander"
    : hunterConfig.useReact
      ? "react"
      : "scripted";
}

async function saveMissionSafely(record: StoredHunterMission): Promise<void> {
  try {
    await missionStore.save(record);
  } catch (error) {
    logHunterError(
      `mission-store: failed to persist ${record.missionId} — ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const runManager = new HunterRunManager(runStore, runHunter, async (record) => {
  await saveMissionSafely({
    missionId: record.missionId,
    goal: record.goal,
    chainId: hunterConfig.chainId,
    authorityId: hunterConfig.altana.authorityId,
    mode: record.result?.mode ?? readRunMode(record.events, record.requestMode),
    status: record.status === "completed" ? "completed" : "failed",
    source: "live-run",
    events: record.events,
    result: record.result,
    error: record.error,
    createdAt: record.createdAt,
    completedAt: record.updatedAt
  });
});

function readGoal(value: unknown): string {
  if (value === undefined || value === null || value === "") return hunterConfig.defaultGoal;
  if (typeof value !== "string" || !value.trim()) {
    throw new HunterError(400, "GOAL_INVALID", "goal must be a non-empty string");
  }
  return value.trim();
}

function readRunIdempotencyKey(req: express.Request): string {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : undefined;
  const queryValue = typeof req.query.idempotencyKey === "string" ? req.query.idempotencyKey : undefined;
  try {
    return validateRunIdempotencyKey(req.get("idempotency-key") ?? queryValue ?? body?.idempotencyKey);
  } catch (error) {
    throw new HunterError(428, "IDEMPOTENCY_KEY_REQUIRED", error instanceof Error ? error.message : "Idempotency-Key is required");
  }
}

async function streamRun(req: express.Request, res: express.Response): Promise<void> {
  const body = req.body as HunterRunRequest | undefined;
  const queryGoal = typeof req.query.goal === "string" ? req.query.goal : undefined;
  const queryMode = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const queryLocale = typeof req.query.locale === "string" ? req.query.locale : undefined;
  let goal: string;
  let idempotencyKey: string;
  try {
    goal = readGoal(body?.goal ?? queryGoal);
    idempotencyKey = readRunIdempotencyKey(req);
  } catch (error) {
    const failure = asHunterError(error);
    res.status(failure.status).json({ code: failure.code, message: failure.message });
    return;
  }
  const requestMode = parseRunMode(body?.mode ?? queryMode);
  const locale = parseLocale(body?.locale ?? queryLocale);

  let submission: Awaited<ReturnType<typeof runManager.submit>>;
  try {
    submission = await runManager.submit({ idempotencyKey, goal, requestMode, locale });
  } catch {
    res.status(503).json({ code: "RUN_STORE_UNAVAILABLE", message: "Run could not be admitted safely" });
    return;
  }
  if (submission.admission.kind === "conflict") {
    res.status(409).json({ code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key is already bound to different run input" });
    return;
  }
  const missionId = submission.admission.record.missionId;
  res.setHeader("X-Mission-Id", missionId);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15000);

  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });

  writeSseEvent(res, "ready", {
    missionId,
    mode: hunterConfig.useReact ? "react" : "scripted",
    agentMode: hunterConfig.useReact ? "react" : "scripted",
    requestMode,
    goal,
    locale,
    replay: submission.admission.kind === "replay"
  }, `${missionId}:0`);

  try {
    const lastId = req.get("last-event-id");
    const parsedOffset = lastId?.startsWith(`${missionId}:`) ? Number(lastId.slice(missionId.length + 1)) : 0;
    let sent = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    for (;;) {
      if (closed || res.writableEnded) break;
      const snapshot = await runManager.get(missionId);
      const record = snapshot.record;
      if (!record) throw new HunterError(500, "RUN_STORE_READ_FAILED", "Run state disappeared");
      while (sent < record.events.length) {
        const eventIndex = sent++;
        writeSseEvent(res, "trace", record.events[eventIndex], `${missionId}:${eventIndex + 1}`);
      }
      if (record.status === "completed" && record.result) {
        writeSseEvent(res, "done", record.result, `${missionId}:${record.events.length + 1}`);
        break;
      }
      if (record.status === "failed" || record.status === "cancelled") {
        writeSseEvent(res, "error", record.error ?? { code: "RUN_FAILED", message: "Run failed" }, `${missionId}:${record.events.length + 1}`);
        break;
      }
      if (!snapshot.activeHere && !runManager.distributed) {
        throw new HunterError(503, "RUN_RECOVERY_REQUIRED", "Run was admitted by another or restarted worker; inspect the durable run before retrying");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    const hunterError = asHunterError(error);
    const localizedError = localizeHunterError(hunterError, locale);
    const payload: ErrorResponse = {
      code: localizedError.code,
      message: localizedError.message,
      details: localizedError.details
    };
    if (!closed && !res.writableEnded) {
      writeSseEvent(res, "error", payload);
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed && !res.writableEnded) {
      res.end();
    }
  }
}

async function readLastSuccessfulPayment(): Promise<{ transaction: string; timestamp: number } | undefined> {
  if (postgresStore) return postgresStore.latestConfirmedX402Payment();
  const candidates = await Promise.all(hunterConfig.altana.paymentEvidencePaths.map(async (filePath) => {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
        records?: Record<string, { payment?: { transaction?: unknown }; updatedAt?: unknown }>;
      };
      return Object.values(parsed.records ?? {}).flatMap((record) => {
        const transaction = record.payment?.transaction;
        const timestamp = record.updatedAt;
        return typeof transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction) &&
          typeof timestamp === "number" ? [{ transaction, timestamp }] : [];
      });
    } catch {
      return [];
    }
  }));
  return candidates.flat().sort((left, right) => right.timestamp - left.timestamp)[0];
}

async function readRegistryHealth(): Promise<{ status: "ok" | "unavailable"; endpoint: string }> {
  try {
    const response = await fetch(`${hunterConfig.registryServiceUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(1_500)
    });
    return { status: response.ok ? "ok" : "unavailable", endpoint: hunterConfig.registryServiceUrl };
  } catch {
    return { status: "unavailable", endpoint: hunterConfig.registryServiceUrl };
  }
}

app.get("/health", async (_req, res) => {
  let address: string | undefined;
  try {
    address = getHunterAddress();
  } catch {
    address = undefined;
  }

  const [lastSuccessfulTestnetTx, registryHeartbeat] = await Promise.all([
    readLastSuccessfulPayment(),
    readRegistryHealth()
  ]);
  const persistenceAvailable = postgresStore
    ? await postgresStore.pool.query("SELECT 1").then(() => true).catch(() => false)
    : true;
  const llmAvailable = hunterConfig.llm.provider !== "none";
  res.status(200).json({
    status: llmAvailable && registryHeartbeat.status === "ok" && persistenceAvailable ? "ok" : "degraded",
    service: "hunter",
    chainId: hunterConfig.chainId,
    mode: hunterConfig.useReact ? "react" : "scripted",
    paymentMode:
      hunterConfig.altana.enabled && hunterConfig.x402.enabled
        ? "altana-x402"
        : hunterConfig.isMockMode
          ? "mock"
          : "chain",
    address,
    walletAddress: address,
    agentId: getHunterIdentity().agentId,
    registryHeartbeat,
    llm: { provider: hunterConfig.llm.provider, available: llmAvailable },
    lastSuccessfulTestnetTx,
    persistence: { backend: hunterConfig.persistence.backend, available: persistenceAvailable }
  });
});

const browserAuthorityApi = browserAuthorityRouter();
app.use('/browser-authority', requireApiAuth, browserAuthorityApi);

app.get("/authority", requireApiAuth, async (_req, res) => {
  const authorityId = hunterConfig.altana.authorityId;
  const encryptionKey = hunterConfig.altana.sessionEncryptionKey;
  if (!hunterConfig.altana.enabled || !authorityId) {
    res.status(503).json({
      code: "ALTANA_AUTHORITY_NOT_CONFIGURED",
      message: "Altana authority is not configured"
    });
    return;
  }

  try {
    const evidence = await authorityEvidenceStore.get(authorityId);
    let authority = evidence?.authority;
    if (encryptionKey && (!authority || authority.status === "active")) {
      try {
        authority = (await loadAltanaAuthority({
          authorityId,
          storePath: hunterConfig.altana.sessionStorePath,
          encryptionKey
        })).authority;
      } catch (error) {
        if (!authority) throw error;
      }
    }
    if (!authority) {
      throw new Error(`Authority not found: ${authorityId}`);
    }
    const now = Math.floor(Date.now() / 1000);
    authority = authority.status === "active" && authority.expiry <= now
      ? { ...authority, status: "expired" as const }
      : authority;
    const frozenEvidenceAt = authority.status === "revoked" && evidence?.updatedAt
      ? (evidence.updatedAt >= 100_000_000_000
          ? Math.floor(evidence.updatedAt / 1_000)
          : evidence.updatedAt)
      : undefined;
    const spending = await readAuthoritySpending({
      authority,
      rpcUrl: hunterConfig.rpcUrl,
      receiptStorePaths: hunterConfig.altana.paymentEvidencePaths,
      receiptEvidenceOnly: authority.status === "revoked",
      receiptEvidenceEnd: frozenEvidenceAt,
      database: postgresStore,
      now: frozenEvidenceAt ?? now
    }).catch((error) => ({
      error: error instanceof Error ? error.message : "Authority spending evidence is unavailable"
    }));
    res.status(200).json({ authority, now, spending, revocation: evidence?.revocation, lifecycle: evidence?.lifecycle });
  } catch (error) {
    const hunterError = asHunterError(error);
    res.status(hunterError.status).json({
      code: hunterError.code,
      message: hunterError.message,
      details: hunterError.details
    });
  }
});

app.get("/identity", async (_req, res) => {
  try {
    const [onchain, balance] = await Promise.all([
      getHunterOnChainRegistrationStatus(),
      checkHunterBalance(),
    ]);
    res.status(200).json({
      identity: getHunterIdentity(),
      onchain,
      balance: balance.balance,
      balanceFormatted: balance.formatted,
    });
  } catch (error) {
    res.status(500).json({
      code: "IDENTITY_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to load identity"
    });
  }
});

app.get("/agent-registration.json", async (_req, res) => {
  try {
    const onchain = await getHunterOnChainRegistrationStatus();
    res.status(200).json(buildErc8004RegistrationFile({
      identity: getHunterIdentity(),
      chainId: hunterConfig.chainId,
      registryAddress: onchain.registered ? onchain.registryAddress : undefined,
      onchainAgentId: onchain.registered ? onchain.agentTokenId : undefined,
      x402Support: hunterConfig.x402.enabled
    }));
  } catch {
    res.status(503).json({ code: "REGISTRATION_FILE_UNAVAILABLE", message: "Agent registration file is temporarily unavailable" });
  }
});

app.get("/missions", requireApiAuth, async (_req, res) => {
  try {
    res.status(200).json({ missions: await missionStore.list() });
  } catch (error) {
    res.status(500).json({
      code: "MISSION_STORE_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to list missions"
    });
  }
});

app.get("/advantage", async (_req, res) => {
  try {
    const [
      missions,
      auditGroundTruth,
      auditToolBaseline,
      tokenRiskSecurityReview,
      tokenRiskEnrichment,
      dueDiligenceCandidate,
      auditModelCandidate,
      tokenRiskModelCandidate,
      dueDiligenceModelCandidate,
      paidDueDiligence,
      comparisonBundle
    ] = await Promise.all([
      missionStore.listRecords(),
      loadAuditGroundTruth(hunterConfig.advantage.auditGroundTruthPath),
      loadAuditToolBaseline(hunterConfig.advantage.auditToolBaselinePath),
      loadTokenRiskSecurityReview(hunterConfig.advantage.tokenRiskSecurityReviewPath),
      loadTokenRiskEnrichment(hunterConfig.advantage.tokenRiskEnrichmentPath),
      loadDueDiligenceCandidate(hunterConfig.advantage.dueDiligenceCandidatePath),
      loadModelOnlyBaselineCandidate(
        hunterConfig.advantage.auditModelCandidatePath,
        "contract-audit"
      ),
      loadModelOnlyBaselineCandidate(
        hunterConfig.advantage.tokenRiskModelCandidatePath,
        "token-risk"
      ),
      loadModelOnlyBaselineCandidate(
        hunterConfig.advantage.dueDiligenceModelCandidatePath,
        "due-diligence",
        hunterConfig.advantage.dueDiligenceModelSlitherPath
      ),
      loadPaidDueDiligence(hunterConfig.advantage.paidDueDiligencePath),
      loadAdvantageComparisonBundle(hunterConfig.advantage.comparisonBundlePath)
    ]);
    res.status(200).json(
      buildAdvantageReport(
        missions,
        Date.now(),
        auditGroundTruth,
        auditToolBaseline,
        tokenRiskSecurityReview,
        tokenRiskEnrichment,
        dueDiligenceCandidate,
        [auditModelCandidate, tokenRiskModelCandidate, dueDiligenceModelCandidate]
          .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)),
        paidDueDiligence,
        comparisonBundle
      )
    );
  } catch (error) {
    res.status(500).json({
      code: "ADVANTAGE_REPORT_FAILED",
      message: error instanceof Error ? error.message : "Failed to build Advantage report"
    });
  }
});

app.get("/missions/:missionId", requireApiAuth, async (req, res) => {
  const missionId = req.params.missionId?.trim();
  if (!missionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(missionId)) {
    res.status(400).json({ code: "MISSION_ID_INVALID", message: "Mission id is invalid" });
    return;
  }
  try {
    let mission = await missionStore.get(missionId);
    if (!mission) {
      mission = await recoverMissionFromEvidence({
        missionId,
        chainId: hunterConfig.chainId,
        authorityId: hunterConfig.altana.authorityId,
        receiptStorePaths: hunterConfig.altana.paymentEvidencePaths,
        database: postgresStore
      });
      if (mission) await saveMissionSafely(mission);
    }
    if (!mission) {
      res.status(404).json({ code: "MISSION_NOT_FOUND", message: "Mission was not found" });
      return;
    }
    res.status(200).json({ mission });
  } catch (error) {
    res.status(500).json({
      code: "MISSION_STORE_READ_FAILED",
      message: error instanceof Error ? error.message : "Failed to read mission"
    });
  }
});

app.post("/run", requireApiAuth, async (req, res) => {
  try {
    const body = req.body as HunterRunRequest | undefined;
    const goal = readGoal(body?.goal);
    const requestMode = parseRunMode(body?.mode);
    const locale = parseLocale(body?.locale);
    const submission = await runManager.submit({
      idempotencyKey: readRunIdempotencyKey(req), goal, requestMode, locale
    });
    if (submission.admission.kind === "conflict") {
      res.status(409).json({ code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key is already bound to different run input" });
      return;
    }
    const missionId = submission.admission.record.missionId;
    res.setHeader("X-Mission-Id", missionId);
    if (submission.admission.record.status === "running" && !submission.activeHere) {
      res.status(503).json({ code: "RUN_RECOVERY_REQUIRED", message: "Run state is durable but this worker cannot prove that execution is still active", missionId });
      return;
    }
    const terminal = submission.admission.record.status === "running"
      ? await runManager.wait(missionId)
      : submission.admission.record;
    if (terminal?.status === "completed" && terminal.result) {
      res.status(200).json(terminal.result);
      return;
    }
    res.status(terminal?.status === "cancelled" ? 409 : 500).json(terminal?.error ?? {
      code: "RUN_FAILED", message: "Run did not produce a terminal result"
    });
  } catch (error) {
    const hunterError = asHunterError(error);
    const localizedError = localizeHunterError(hunterError, parseLocale((req.body as HunterRunRequest | undefined)?.locale));
    const payload: ErrorResponse = {
      code: localizedError.code,
      message: localizedError.message,
      details: localizedError.details
    };
    res.status(localizedError.status).json(payload);
  }
});

app.get("/runs/:missionId", requireApiAuth, async (req, res) => {
  const missionId = req.params.missionId;
  if (!/^[a-f0-9-]{36}$/i.test(missionId)) {
    res.status(400).json({ code: "MISSION_ID_INVALID", message: "Mission id is invalid" });
    return;
  }
  try {
    const state = await runManager.get(missionId);
    if (!state.record) {
      res.status(404).json({ code: "RUN_NOT_FOUND", message: "Run was not found" });
      return;
    }
    res.status(200).json({ run: publicRunRecord(state.record), activeHere: state.activeHere });
  } catch {
    res.status(503).json({ code: "RUN_STORE_UNAVAILABLE", message: "Run state is temporarily unavailable" });
  }
});

app.post("/runs/:missionId/cancel", requireApiAuth, async (req, res) => {
  const missionId = req.params.missionId;
  if (!/^[a-f0-9-]{36}$/i.test(missionId)) {
    res.status(400).json({ code: "MISSION_ID_INVALID", message: "Mission id is invalid" });
    return;
  }
  try {
    const cancellation = await runManager.cancel(missionId);
    if (!cancellation.record) {
      res.status(404).json({ code: "RUN_NOT_FOUND", message: "Run was not found" });
      return;
    }
    if (!cancellation.accepted) {
      res.status(409).json({ code: "RUN_NOT_CANCELLABLE", message: "Run is terminal or belongs to a different worker", run: publicRunRecord(cancellation.record) });
      return;
    }
    res.status(202).json({ run: publicRunRecord(cancellation.record) });
  } catch {
    res.status(503).json({ code: "RUN_STORE_UNAVAILABLE", message: "Run state is temporarily unavailable" });
  }
});

app.post("/run/stream", requireApiAuth, async (req, res) => {
  await streamRun(req, res);
});

app.get("/run/stream", requireApiAuth, async (req, res) => {
  await streamRun(req, res);
});

const server = app.listen(hunterConfig.port, () => {
  void registerHunterIdentityOnChain();
  console.log(
    `[hunter] running on :${hunterConfig.port} | mode=${hunterConfig.useReact ? "react" : "scripted"} | payment=${hunterConfig.altana.enabled && hunterConfig.x402.enabled ? "altana-x402" : hunterConfig.isMockMode ? "mock" : "chain"} | llm=${hunterConfig.llm.provider}:${hunterConfig.llm.model} | store=${hunterConfig.persistence.backend}`
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runManager.shutdown();
  browserAuthorityApi.shutdown();
  server.close(async () => {
    await closeProcessPostgresStores().catch(() => undefined);
  });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
