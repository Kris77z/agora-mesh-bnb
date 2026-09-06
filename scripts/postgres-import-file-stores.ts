import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertPostgresSchemaCurrent,
  createPostgresPool,
  type AgentFeedback,
  type AuthorityRecord,
  type HunterTraceEvent,
  type ServiceInfo,
  type X402ExecuteSuccessResponse,
  type X402ExecutionRequest,
  type X402PaymentCompleted
} from "@rebel/shared";

const CONFIRMATION = "I_CONFIRM_FROZEN_FILE_IMPORT";
const defaultDatabaseUrl =
  "postgresql://agora_runtime:agora_runtime_local@127.0.0.1:55432/agora_mesh";
const databaseUrl = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
const repositoryRoot = path.resolve(process.env.AGORA_IMPORT_ROOT?.trim() || process.cwd());
const registryRoot = path.join(repositoryRoot, "registry");

interface SourceFile<T> {
  absolutePath: string;
  relativePath: string;
  raw: string;
  value: T;
}

interface StoredRun {
  missionId: string;
  goal: string;
  requestMode: "single" | "commander";
  locale: string;
  status: "completed" | "failed" | "cancelled" | "running";
  events: HunterTraceEvent[];
  result?: unknown;
  error?: unknown;
  cancelRequested?: boolean;
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  idempotencyHash: string;
  requestHash: string;
}

interface StoredMission {
  missionId: string;
  goal: string;
  chainId: number;
  authorityId?: string;
  mode: "scripted" | "react" | "commander";
  status: "completed" | "failed";
  source: "live-run" | "recovered-evidence";
  events: HunterTraceEvent[];
  result?: unknown;
  error?: unknown;
  createdAt: number;
  completedAt: number;
}

interface StoredPurchase {
  service: ServiceInfo;
  request: X402ExecutionRequest;
  requirement: unknown;
  selectedAccept: {
    network: string;
    asset: string;
    payTo: string;
    amount: string;
  };
}

interface StoredExecution {
  idempotencyKey: string;
  requestHash: string;
  serviceId: string;
  request?: X402ExecutionRequest;
  payment?: X402PaymentCompleted;
  response?: X402ExecuteSuccessResponse;
  settlement?: { state: "attempting" | "uncertain"; startedAt: number };
  lastError?: string;
  updatedAt: number;
}

interface StoredAuthorityEvidence {
  authority: AuthorityRecord;
  lifecycle?: {
    operation: "provision" | "revoke";
    phase: "in-progress" | "blocked" | "complete";
    pendingStep?: string;
    transactions: Record<string, string>;
    reconciled?: unknown;
  };
  revocation?: unknown;
  updatedAt: number;
}

interface DynamicServiceEntry {
  agentId: string;
  service: ServiceInfo;
  updatedAt: number;
  expiresAt: number;
}

interface ServiceFeedbackEntry {
  serviceId: string;
  hunterId: string;
  missionId: string;
  score: number;
  taskType: string;
  comment?: string;
  timestamp: number;
}

interface OnchainIdentityRecord {
  key: string;
  role: "hunter" | "writer";
  registryAddress: string;
  chainId: number;
  walletAddress: string;
  agentUri: string;
  txHash: string;
  agentTokenId?: string;
  registeredAt: number;
  agentWalletAddress?: string;
  agentWalletSetTxHash?: string;
  agentWalletSetAt?: number;
  agentWalletSetDeadline?: number;
  agentWalletSignatureProfileId?: string;
}

interface HunterExperience {
  missionId: string;
  goal: string;
  serviceUsed: string;
  taskType: string;
  score: number;
  lesson: string;
  lessonTranslations?: { "en-US"?: string; "zh-CN"?: string };
  timestamp: number;
}

interface ImportSource {
  files: Array<SourceFile<unknown>>;
  runs: StoredRun[];
  missions: StoredMission[];
  purchases: Array<{ fileKey: string; record: StoredPurchase }>;
  executions: StoredExecution[];
  authorities: StoredAuthorityEvidence[];
  dynamicServices: DynamicServiceEntry[];
  serviceFeedback: ServiceFeedbackEntry[];
  agentFeedback: AgentFeedback[];
  onchainIdentities: OnchainIdentityRecord[];
  hunterExperiences: HunterExperience[];
}

interface ImportCounts {
  runs: number;
  runEvents: number;
  missions: number;
  purchases: number;
  executions: number;
  settlementBindings: number;
  chainTransactions: number;
  authorities: number;
  authoritySteps: number;
  serviceLeases: number;
  serviceFeedback: number;
  agentFeedback: number;
  agentIdentities: number;
  onchainIdentities: number;
  hunterExperiences: number;
  purchaseAmount: string;
  paidAmount: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = sha256(value).slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bareHash(value: string, label: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${label} must be 32 bytes`);
  return normalized.toLowerCase();
}

function txHash(value: string, label: string): string {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${label} must be a transaction hash`);
  return normalized;
}

function address(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an EVM address`);
  return value;
}

function uint(value: unknown, label: string): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^(0|[1-9]\d*)$/.test(normalized)) throw new Error(`${label} must be an unsigned integer`);
  return normalized;
}

function epochDate(value: number, label: string): Date {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive timestamp`);
  const date = new Date(value >= 100_000_000_000 ? value : value * 1_000);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectSecretFields(value: unknown, source: string, trail: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, source, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(privateKey|sessionPrivateKey|sessionSecret|paymentSignature|authorizationHeader|xPayment)$/i.test(key)) {
      throw new Error(`Secret-like field ${[...trail, key].join(".")} is forbidden in ${source}`);
    }
    rejectSecretFields(child, source, [...trail, key]);
  }
}

async function readJson<T>(absolutePath: string, optional = false): Promise<SourceFile<T> | undefined> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    const value = JSON.parse(raw) as T;
    const relativePath = path.relative(repositoryRoot, absolutePath);
    rejectSecretFields(value, relativePath);
    return { absolutePath, relativePath, raw, value };
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadSource(): Promise<ImportSource> {
  const files: Array<SourceFile<unknown>> = [];
  const add = <T>(file: SourceFile<T> | undefined): SourceFile<T> | undefined => {
    if (file) files.push(file as SourceFile<unknown>);
    return file;
  };
  const runsFile = add(await readJson<{ version: number; records: Record<string, StoredRun> }>(
    path.join(registryRoot, "runs.json"), true
  ));
  const missionsFile = add(await readJson<{ version: number; records: Record<string, StoredMission> }>(
    path.join(registryRoot, "missions.json"), true
  ));
  const dynamicFile = add(await readJson<{ services: DynamicServiceEntry[] }>(
    path.join(registryRoot, "dynamic-services.json"), true
  ));
  const serviceFeedbackFile = add(await readJson<{ feedback: ServiceFeedbackEntry[] }>(
    path.join(registryRoot, "service-feedback-store.json"), true
  ));
  const agentFeedbackFile = add(await readJson<{ feedback: AgentFeedback[] }>(
    path.join(registryRoot, "feedback-store.json"), true
  ));
  const authorityFile = add(await readJson<{ version: number; records: Record<string, StoredAuthorityEvidence> }>(
    path.join(registryRoot, "authority-evidence.json"), true
  ));
  const onchainIdentityFile = add(await readJson<{ records: OnchainIdentityRecord[] }>(
    path.join(registryRoot, "onchain-identity-store.json"), true
  ));
  const hunterExperienceFile = add(await readJson<{ experiences: HunterExperience[] }>(
    path.join(repositoryRoot, "agents/hunter/memory/experience.json"), true
  ));

  const purchases: Array<{ fileKey: string; record: StoredPurchase }> = [];
  const purchaseDirectory = path.join(registryRoot, "x402-purchases");
  const purchaseNames = await readdir(purchaseDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of purchaseNames.filter((item) => /^[0-9a-f]{64}\.json$/i.test(item)).sort()) {
    const file = add(await readJson<StoredPurchase>(path.join(purchaseDirectory, name)));
    purchases.push({ fileKey: name.slice(0, -5).toLowerCase(), record: file!.value });
  }

  const executions: StoredExecution[] = [];
  const registryNames = await readdir(registryRoot);
  for (const name of registryNames.filter((item) => /^x402-.+-receipts\.json$/i.test(item)).sort()) {
    const file = add(await readJson<{ version: number; records: Record<string, StoredExecution> }>(
      path.join(registryRoot, name)
    ));
    executions.push(...Object.values(file!.value.records ?? {}));
  }

  const runs = Object.values(runsFile?.value.records ?? {});
  const missions = Object.values(missionsFile?.value.records ?? {});
  const authorities = Object.values(authorityFile?.value.records ?? {});
  const dynamicServices = dynamicFile?.value.services ?? [];
  const serviceFeedback = serviceFeedbackFile?.value.feedback ?? [];
  const agentFeedback = agentFeedbackFile?.value.feedback ?? [];
  const onchainIdentities = onchainIdentityFile?.value.records ?? [];
  const hunterExperiences = hunterExperienceFile?.value.experiences ?? [];

  if (runsFile && runsFile.value.version !== 1) throw new Error("runs.json has an unsupported version");
  if (missionsFile && missionsFile.value.version !== 1) throw new Error("missions.json has an unsupported version");
  if (authorityFile && authorityFile.value.version !== 1) throw new Error("authority-evidence.json has an unsupported version");
  if (dynamicFile && !Array.isArray(dynamicServices)) throw new Error("dynamic-services.json is malformed");
  if (serviceFeedbackFile && !Array.isArray(serviceFeedback)) throw new Error("service-feedback-store.json is malformed");
  if (agentFeedbackFile && !Array.isArray(agentFeedback)) throw new Error("feedback-store.json is malformed");
  if (onchainIdentityFile && !Array.isArray(onchainIdentities)) throw new Error("onchain-identity-store.json is malformed");
  if (hunterExperienceFile && !Array.isArray(hunterExperiences)) throw new Error("experience.json is malformed");
  if (runs.some((run) => run.status === "running")) {
    throw new Error("File import requires every Hunter run to be stopped or terminal");
  }
  return {
    files, runs, missions, purchases, executions, authorities,
    dynamicServices, serviceFeedback, agentFeedback,
    onchainIdentities, hunterExperiences
  };
}

function serviceLeaseMap(entries: DynamicServiceEntry[]): Map<string, DynamicServiceEntry> {
  const result = new Map<string, DynamicServiceEntry>();
  for (const entry of entries) {
    if (!entry.service?.id) throw new Error("Dynamic service entry is missing service.id");
    const current = result.get(entry.service.id);
    if (!current || entry.updatedAt >= current.updatedAt) result.set(entry.service.id, entry);
  }
  return result;
}

function purchaseParentIds(source: ImportSource): Set<string> {
  return new Set(source.purchases.map(({ record }) => record.request?.missionId).filter(Boolean));
}

function sourceCounts(source: ImportSource): ImportCounts {
  const runIds = new Set(source.runs.map((run) => run.missionId));
  const syntheticRuns = [...purchaseParentIds(source)].filter((missionId) => !runIds.has(missionId));
  const chainKeys = new Set<string>();
  let purchaseAmount = 0n;
  let paidAmount = 0n;
  let settlementBindings = 0;
  for (const { record } of source.purchases) purchaseAmount += BigInt(uint(record.selectedAccept.amount, "purchase amount"));
  for (const record of source.executions) {
    if (record.payment) {
      settlementBindings += 1;
      chainKeys.add(`${record.payment.amount.asset.chainId}:${txHash(record.payment.transaction, "payment transaction").toLowerCase()}`);
      paidAmount += BigInt(uint(record.payment.amount.amount, "payment amount"));
    }
  }
  const authoritySteps = new Set<string>();
  for (const record of source.authorities) {
    const hashes = [
      record.authority.grantTxHash,
      record.authority.revokeTxHash,
      ...Object.values(record.lifecycle?.transactions ?? {})
    ].filter((item): item is string => typeof item === "string");
    for (const hash of hashes) chainKeys.add(`${record.authority.chainId}:${txHash(hash, "Authority transaction").toLowerCase()}`);
    for (const step of new Set([
      ...Object.keys(record.lifecycle?.transactions ?? {}),
      ...(record.lifecycle?.pendingStep ? [record.lifecycle.pendingStep] : [])
    ])) authoritySteps.add(`${record.authority.authorityId}:${step}`);
  }
  return {
    runs: source.runs.length + syntheticRuns.length,
    runEvents: source.runs.reduce((sum, run) => sum + (run.events?.length ?? 0), 0),
    missions: source.missions.length,
    purchases: source.purchases.length,
    executions: source.executions.length,
    settlementBindings,
    chainTransactions: chainKeys.size,
    authorities: source.authorities.length,
    authoritySteps: authoritySteps.size,
    serviceLeases: serviceLeaseMap(source.dynamicServices).size,
    serviceFeedback: source.serviceFeedback.length,
    agentFeedback: source.agentFeedback.length,
    agentIdentities: 0,
    onchainIdentities: source.onchainIdentities.length,
    hunterExperiences: source.hunterExperiences.length,
    purchaseAmount: purchaseAmount.toString(),
    paidAmount: paidAmount.toString()
  };
}

function executionState(record: StoredExecution): string {
  if (record.response) return "completed";
  if (record.payment && record.lastError) return "execution_pending";
  if (record.payment) return "paid";
  if (record.settlement?.state === "uncertain") return "settlement_uncertain";
  if (record.settlement?.state === "attempting") return "settlement_attempting";
  return "failed";
}

async function databaseCounts(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }): Promise<ImportCounts> {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM runs) AS runs,
      (SELECT count(*)::int FROM run_events) AS "runEvents",
      (SELECT count(*)::int FROM missions) AS missions,
      (SELECT count(*)::int FROM x402_purchases) AS purchases,
      (SELECT count(*)::int FROM x402_executions) AS executions,
      (SELECT count(*)::int FROM x402_executions
         WHERE settlement_transaction_id IS NOT NULL) AS "settlementBindings",
      (SELECT count(*)::int FROM chain_transactions) AS "chainTransactions",
      (SELECT count(*)::int FROM authorities) AS authorities,
      (SELECT count(*)::int FROM authority_steps) AS "authoritySteps",
      (SELECT count(*)::int FROM service_leases) AS "serviceLeases",
      (SELECT count(*)::int FROM service_feedback) AS "serviceFeedback",
      (SELECT count(*)::int FROM agent_feedback) AS "agentFeedback",
      (SELECT count(*)::int FROM agent_identities) AS "agentIdentities",
      (SELECT count(*)::int FROM onchain_identities) AS "onchainIdentities",
      (SELECT count(*)::int FROM hunter_experiences) AS "hunterExperiences",
      (SELECT COALESCE(sum(amount), 0)::text FROM x402_purchases) AS "purchaseAmount",
      (SELECT COALESCE(sum((payment_evidence->'amount'->>'amount')::numeric), 0)::text
         FROM x402_executions WHERE payment_evidence ? 'amount') AS "paidAmount"
  `);
  return result.rows[0] as ImportCounts;
}

function countsEqual(left: ImportCounts, right: ImportCounts): boolean {
  return Object.keys(left).every((key) => String(left[key as keyof ImportCounts]) === String(right[key as keyof ImportCounts]));
}

async function importSource(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> },
  source: ImportSource,
  sourceDigest: string,
  manifest: unknown,
  expected: ImportCounts
): Promise<void> {
  for (const run of source.runs) {
    if (!run.missionId?.trim()) throw new Error("Hunter run missionId is missing");
    const events = Array.isArray(run.events) ? run.events : [];
    const status = run.status;
    if (!(["completed", "failed", "cancelled"] as string[]).includes(status)) {
      throw new Error(`Hunter run ${run.missionId} is not terminal`);
    }
    const requestHash = bareHash(run.requestHash, `run ${run.missionId} requestHash`);
    const idempotencyHash = bareHash(run.idempotencyHash, `run ${run.missionId} idempotencyHash`);
    await client.query(`
      INSERT INTO runs (
        mission_id, scope, owner_id, goal, request_mode, locale, request_hash,
        status, result, error, cancel_requested, fencing_token,
        next_event_sequence, created_at, updated_at
      ) VALUES ($1, 'hunter-run', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                $10, 1, $11, $12, $13)
    `, [
      run.missionId, run.ownerId || "file-import", run.goal, run.requestMode, run.locale,
      requestHash, status, run.result === undefined ? null : JSON.stringify(run.result),
      run.error === undefined ? null : JSON.stringify(run.error), Boolean(run.cancelRequested),
      events.length + 1, epochDate(run.createdAt, "run createdAt"), epochDate(run.updatedAt, "run updatedAt")
    ]);
    await client.query(`
      INSERT INTO run_idempotency(scope, key_hash, mission_id, request_hash, created_at)
      VALUES ('hunter-run', $1, $2, $3, $4)
    `, [idempotencyHash, run.missionId, requestHash, epochDate(run.createdAt, "run createdAt")]);
    for (const [index, event] of events.entries()) {
      await client.query(`
        INSERT INTO run_events(mission_id, sequence, event_type, payload, occurred_at, fencing_token)
        VALUES ($1, $2, $3, $4::jsonb, $5, 1)
      `, [
        run.missionId, index + 1, event.type || "imported-event", JSON.stringify(event),
        event.at ? new Date(event.at) : epochDate(run.createdAt, "run event timestamp")
      ]);
    }
  }

  const existingRunIds = new Set(source.runs.map((run) => run.missionId));
  for (const missionId of purchaseParentIds(source)) {
    if (existingRunIds.has(missionId)) continue;
    const related = source.purchases.filter(({ record }) => record.request.missionId === missionId);
    const timestamp = Math.min(...related.map(({ record }) => record.request.timestamp * 1_000));
    const requestHash = sha256(`imported-x402-parent:${missionId}`);
    const idempotencyHash = sha256(`imported-x402-idempotency:${missionId}`);
    await client.query(`
      INSERT INTO runs (
        mission_id, scope, owner_id, goal, request_mode, locale, request_hash,
        status, result, fencing_token, created_at, updated_at
      ) VALUES ($1, 'imported-x402-history', 'file-import', $2, 'single', $3, $4,
                'completed', $5::jsonb, 1, $6, $6)
    `, [
      missionId, `Imported x402 history for ${related.map(({ record }) => record.service.id).join(", ")}`,
      related[0]?.record.request.locale ?? "en-US", requestHash,
      JSON.stringify({ importedHistory: true, serviceIds: related.map(({ record }) => record.service.id) }),
      epochDate(Number.isFinite(timestamp) ? timestamp : Date.now(), "purchase timestamp")
    ]);
    await client.query(`
      INSERT INTO run_idempotency(scope, key_hash, mission_id, request_hash)
      VALUES ('imported-x402-history', $1, $2, $3)
    `, [idempotencyHash, missionId, requestHash]);
  }

  for (const mission of source.missions) {
    await client.query(`
      INSERT INTO missions (
        mission_id, goal, chain_id, authority_id, mode, status, source,
        events, result, error, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
    `, [
      mission.missionId, mission.goal, mission.chainId, mission.authorityId ?? null,
      mission.mode, mission.status, mission.source, JSON.stringify(mission.events),
      mission.result === undefined ? null : JSON.stringify(mission.result),
      mission.error === undefined ? null : JSON.stringify(mission.error),
      epochDate(mission.createdAt, "mission createdAt"),
      epochDate(mission.completedAt, "mission completedAt")
    ]);
  }

  for (const { fileKey, record } of source.purchases) {
    requireObject(record, "x402 purchase");
    const chainMatch = /^eip155:(\d+)$/.exec(record.selectedAccept.network);
    const chainId = chainMatch ? Number(chainMatch[1]) : record.service.asset?.chainId;
    if (!chainId || !Number.isSafeInteger(chainId)) throw new Error("x402 purchase chain is invalid");
    await client.query(`
      INSERT INTO x402_purchases (
        purchase_id, mission_id, service_id, idempotency_key_hash, request_hash,
        chain_id, asset_kind, asset_address, asset_symbol, asset_decimals,
        amount, recipient, request, requirement, selected_accept, service
      ) VALUES ($1, $2, $3, $4, $5, $6, 'erc20', $7, $8, $9, $10, $11,
                $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb)
    `, [
      deterministicUuid(`purchase:${fileKey}`), record.request.missionId, record.request.serviceId,
      bareHash(fileKey, "purchase file key"), bareHash(record.request.requestHash, "purchase requestHash"),
      chainId, address(record.selectedAccept.asset, "purchase asset"),
      record.service.asset?.symbol ?? record.service.currency,
      record.service.asset?.decimals ?? 18, uint(record.selectedAccept.amount, "purchase amount"),
      address(record.selectedAccept.payTo, "purchase recipient"), JSON.stringify(record.request),
      JSON.stringify(record.requirement), JSON.stringify(record.selectedAccept), JSON.stringify(record.service)
    ]);
  }

  for (const record of source.executions) {
    const idempotencyKeyHash = bareHash(record.idempotencyKey, "execution idempotency key");
    const requestHash = bareHash(record.requestHash, "execution requestHash");
    const purchase = await client.query(`
      SELECT purchase_id FROM x402_purchases
      WHERE service_id = $1 AND request_hash = $2
      ORDER BY created_at LIMIT 1
    `, [record.serviceId, requestHash]);
    const state = executionState(record);
    const request = record.request ?? {
      importedLegacy: true,
      serviceId: record.serviceId,
      requestHash: `0x${requestHash}`,
      idempotencyKey: record.idempotencyKey
    };
    await client.query(`
      INSERT INTO x402_executions (
        execution_id, service_id, idempotency_key_hash, request_hash, purchase_id,
        state, request, payment_evidence, response, last_error, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $11)
    `, [
      deterministicUuid(`execution:${record.serviceId}:${idempotencyKeyHash}`), record.serviceId,
      idempotencyKeyHash, requestHash, purchase.rows[0]?.purchase_id ?? null, state,
      JSON.stringify(request), record.payment ? JSON.stringify(record.payment) : null,
      record.response ? JSON.stringify(record.response) : null, record.lastError ?? null,
      epochDate(record.updatedAt, "execution updatedAt")
    ]);
    if (record.payment) {
      const payment = record.payment;
      const transaction = await client.query(`
        INSERT INTO chain_transactions (
          transaction_id, chain_id, tx_hash, purpose, from_address, to_address,
          asset_address, amount, status, metadata, confirmed_at
        ) VALUES ($1, $2, $3, 'x402-payment-import', $4, $5, $6, $7, 'confirmed', $8::jsonb, $9)
        ON CONFLICT (chain_id, tx_hash) DO UPDATE SET
          status = 'confirmed', confirmed_at = COALESCE(chain_transactions.confirmed_at, EXCLUDED.confirmed_at),
          metadata = chain_transactions.metadata || EXCLUDED.metadata
        RETURNING transaction_id
      `, [
        deterministicUuid(`chain:${payment.amount.asset.chainId}:${payment.transaction.toLowerCase()}`),
        payment.amount.asset.chainId, txHash(payment.transaction, "payment transaction"),
        address(payment.payer, "payment payer"), address(payment.recipient, "payment recipient"),
        payment.amount.asset.address ? address(payment.amount.asset.address, "payment asset") : null,
        uint(payment.amount.amount, "payment amount"),
        JSON.stringify({ imported: true, serviceId: record.serviceId, requestHash: `0x${requestHash}` }),
        epochDate(record.updatedAt, "payment timestamp")
      ]);
      await client.query(`
        UPDATE x402_executions SET settlement_transaction_id = $3
        WHERE service_id = $1 AND idempotency_key_hash = $2
      `, [record.serviceId, idempotencyKeyHash, transaction.rows[0].transaction_id]);
    }
    if (purchase.rows[0]?.purchase_id) {
      await client.query(`
        UPDATE x402_purchases SET state = $2,
          payment_evidence = COALESCE($3::jsonb, payment_evidence),
          result = COALESCE($4::jsonb, result), updated_at = $5
        WHERE purchase_id = $1
      `, [
        purchase.rows[0].purchase_id, state,
        record.payment ? JSON.stringify(record.payment) : null,
        record.response ? JSON.stringify(record.response) : null,
        epochDate(record.updatedAt, "purchase execution timestamp")
      ]);
    }
  }

  for (const record of source.authorities) {
    const authority = record.authority;
    const transactions = record.lifecycle?.transactions ?? {};
    const evidenceHashes = new Set([
      authority.grantTxHash,
      authority.revokeTxHash,
      ...Object.values(transactions)
    ].filter((item): item is string => typeof item === "string"));
    const transactionIds = new Map<string, string>();
    for (const hash of evidenceHashes) {
      const normalized = txHash(hash, "Authority transaction");
      const isPending = record.lifecycle?.pendingStep && transactions[record.lifecycle.pendingStep] === hash;
      const id = deterministicUuid(`chain:${authority.chainId}:${normalized.toLowerCase()}`);
      const inserted = await client.query(`
        INSERT INTO chain_transactions (
          transaction_id, chain_id, tx_hash, purpose, status, metadata, confirmed_at
        ) VALUES ($1, $2, $3, 'authority-lifecycle-import', $4, $5::jsonb,
                  CASE WHEN $4 = 'confirmed' THEN $6::timestamptz ELSE NULL END)
        ON CONFLICT (chain_id, tx_hash) DO UPDATE SET
          status = CASE WHEN EXCLUDED.status = 'confirmed' THEN 'confirmed' ELSE chain_transactions.status END,
          metadata = chain_transactions.metadata || EXCLUDED.metadata,
          confirmed_at = COALESCE(chain_transactions.confirmed_at, EXCLUDED.confirmed_at)
        RETURNING transaction_id
      `, [
        id, authority.chainId, normalized, isPending ? "submitted" : "confirmed",
        JSON.stringify({ imported: true, authorityId: authority.authorityId }),
        epochDate(record.updatedAt, "Authority evidence timestamp")
      ]);
      transactionIds.set(hash, inserted.rows[0].transaction_id);
    }
    await client.query(`
      INSERT INTO authorities (
        authority_id, wallet_address, session_public_key, chain_id, allowed_calls,
        spend_limits, expires_at, status, grant_transaction_id, revoke_transaction_id,
        lifecycle, revocation, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10,
                $11::jsonb, $12::jsonb, $13, $14)
    `, [
      authority.authorityId, address(authority.walletAddress, "Authority wallet"),
      authority.sessionPublicKey, authority.chainId, JSON.stringify(authority.allowedCalls),
      JSON.stringify(authority.spendLimits), epochDate(authority.expiry, "Authority expiry"),
      authority.status, authority.grantTxHash ? transactionIds.get(authority.grantTxHash) : null,
      authority.revokeTxHash ? transactionIds.get(authority.revokeTxHash) : null,
      record.lifecycle ? JSON.stringify(record.lifecycle) : null,
      record.revocation ? JSON.stringify(record.revocation) : null,
      epochDate(authority.createdAt, "Authority createdAt"),
      epochDate(record.updatedAt, "Authority updatedAt")
    ]);
    const steps = new Set([
      ...Object.keys(transactions),
      ...(record.lifecycle?.pendingStep ? [record.lifecycle.pendingStep] : [])
    ]);
    for (const step of steps) {
      const hash = transactions[step];
      const state = record.lifecycle?.pendingStep === step ? (hash ? "uncertain" : "pending") : hash ? "confirmed" : "pending";
      await client.query(`
        INSERT INTO authority_steps (
          authority_id, step, attempt, state, transaction_id, public_evidence, completed_at
        ) VALUES ($1, $2, 1, $3, $4, $5::jsonb,
                  CASE WHEN $3 = 'confirmed' THEN $6::timestamptz ELSE NULL END)
      `, [
        authority.authorityId, step, state, hash ? transactionIds.get(hash) : null,
        JSON.stringify(hash ? { txHash: hash, imported: true } : { imported: true }),
        epochDate(record.updatedAt, "Authority step timestamp")
      ]);
    }
  }

  for (const entry of serviceLeaseMap(source.dynamicServices).values()) {
    await client.query(`
      INSERT INTO service_leases (
        service_id, agent_id, endpoint, capability, runtime_available,
        expires_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
    `, [
      entry.service.id, entry.agentId, entry.service.endpoint, JSON.stringify(entry.service),
      entry.service.availability?.available !== false,
      epochDate(entry.expiresAt, "service lease expiry"),
      epochDate(entry.updatedAt, "service lease update")
    ]);
  }

  for (const [index, entry] of source.serviceFeedback.entries()) {
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) {
      throw new Error(`Service feedback ${index} score is outside 0-100`);
    }
    await client.query(`
      INSERT INTO service_feedback (
        feedback_id, service_id, agent_id, mission_id, value, evidence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `, [
      deterministicUuid(`service-feedback:${index}:${JSON.stringify(entry)}`), entry.serviceId,
      entry.hunterId, entry.missionId, entry.score,
      JSON.stringify({ taskType: entry.taskType, ...(entry.comment ? { comment: entry.comment } : {}), imported: true }),
      epochDate(entry.timestamp, "service feedback timestamp")
    ]);
  }

  for (const [index, entry] of source.agentFeedback.entries()) {
    if (!Number.isInteger(entry.value) || entry.value < 0 || entry.value > 100) {
      throw new Error(`Agent feedback ${index} value is outside 0-100`);
    }
    await client.query(`
      INSERT INTO agent_feedback (
        feedback_id, agent_id, reviewer, value, tags, text, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    `, [
      deterministicUuid(`agent-feedback:${index}:${JSON.stringify(entry)}`), entry.agentId,
      entry.reviewer, entry.value, JSON.stringify(entry.tags), entry.text ?? null,
      epochDate(entry.timestamp, "agent feedback timestamp")
    ]);
  }

  for (const record of source.onchainIdentities) {
    await client.query(`
      INSERT INTO onchain_identities (
        identity_key, role, registry_address, chain_id, wallet_address,
        record, registered_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `, [
      record.key, record.role, record.registryAddress, record.chainId,
      record.walletAddress, JSON.stringify(record),
      epochDate(record.registeredAt, "onchain identity registeredAt")
    ]);
  }

  for (const [index, experience] of source.hunterExperiences.entries()) {
    const contentHash = sha256(JSON.stringify(experience));
    await client.query(`
      INSERT INTO hunter_experiences (
        experience_id, content_hash, mission_id, experience, occurred_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (content_hash) DO NOTHING
    `, [
      deterministicUuid(`hunter-experience:${index}:${contentHash}`), contentHash,
      experience.missionId, JSON.stringify(experience),
      epochDate(experience.timestamp, "Hunter experience timestamp")
    ]);
  }

  await client.query(`
    INSERT INTO file_imports(source_digest, manifest, row_counts)
    VALUES ($1, $2::jsonb, $3::jsonb)
  `, [sourceDigest, JSON.stringify(manifest), JSON.stringify(expected)]);
}

async function main(): Promise<void> {
  const source = await loadSource();
  const manifestFiles = source.files
    .map((file) => ({ path: file.relativePath, bytes: Buffer.byteLength(file.raw), sha256: sha256(file.raw) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    version: 1,
    files: manifestFiles,
    excludedSecretStores: ["registry/altana-sessions.json"],
    derivedStores: ["agents/hunter/memory/insights.json"],
    note: "Only public/business state is included; no Session private key or payment signature material. Derived insights are rebuilt from imported experiences."
  };
  const sourceDigest = sha256(JSON.stringify(manifestFiles));
  const expected = sourceCounts(source);
  const apply = process.env.AGORA_FILE_IMPORT_CONFIRM === CONFIRMATION;
  if (process.env.AGORA_FILE_IMPORT_CONFIRM && !apply) {
    throw new Error(`AGORA_FILE_IMPORT_CONFIRM must equal ${CONFIRMATION}`);
  }

  const pool = createPostgresPool({
    connectionString: databaseUrl,
    applicationName: "agora-file-import",
    maxConnections: 1,
    statementTimeoutMs: 60_000,
    lockTimeoutMs: 5_000
  });
  try {
    await assertPostgresSchemaCurrent(pool);
    const client = await pool.connect();
    try {
      const before = await databaseCounts(client);
      const existing = await client.query("SELECT row_counts FROM file_imports WHERE source_digest = $1", [sourceDigest]);
      if (!apply) {
        process.stdout.write(`${JSON.stringify({
          mode: "dry-run",
          sourceDigest,
          manifest,
          expected,
          target: { empty: Object.values(before).every((value) => value === 0 || value === "0"), counts: before },
          alreadyImported: existing.rows.length === 1,
          apply: `Set AGORA_FILE_IMPORT_CONFIRM=${CONFIRMATION} only after stopping and freezing file writers.`
        }, null, 2)}\n`);
        return;
      }
      if (existing.rows.length) {
        if (!countsEqual(expected, existing.rows[0].row_counts as ImportCounts)) {
          throw new Error("Existing import ledger does not match this source snapshot");
        }
        process.stdout.write(`${JSON.stringify({
          mode: "apply", sourceDigest, alreadyImported: true, verified: true,
          importedBaseline: expected, currentCounts: before
        }, null, 2)}\n`);
        return;
      }
      const nonEmpty = Object.entries(before).filter(([, value]) => value !== 0 && value !== "0");
      if (nonEmpty.length) {
        throw new Error(`Target database is not empty (${nonEmpty.map(([key]) => key).join(", ")}); import into an isolated empty database`);
      }
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('agora_mesh_file_import'))");
        await importSource(client, source, sourceDigest, manifest, expected);
        const actual = await databaseCounts(client);
        if (!countsEqual(expected, actual)) {
          throw new Error(`Imported totals differ from source: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
        }
        await client.query("COMMIT");
        process.stdout.write(`${JSON.stringify({
          mode: "apply", sourceDigest, alreadyImported: false, verified: true,
          counts: actual, excludedSecretStores: manifest.excludedSecretStores
        }, null, 2)}\n`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`PostgreSQL file import failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
