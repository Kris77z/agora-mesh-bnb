import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProcessPostgresStore, PostgresCoordinationStore, withLocalFileLock } from "@rebel/shared";
import type { HunterRunRequestMode, HunterTraceEvent, LanguageCode } from "@rebel/shared";
import type { HunterRunResult } from "./run-types.js";

export type HunterRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface HunterRunRecord {
  missionId: string;
  goal: string;
  requestMode: HunterRunRequestMode;
  locale: LanguageCode;
  status: HunterRunStatus;
  events: HunterTraceEvent[];
  result?: HunterRunResult;
  error?: { code: string; message: string };
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  /** Internal ownership metadata. Never expose this field over HTTP. */
  ownerId: string;
  /** SHA-256 digests only; the caller's idempotency key is never persisted. */
  idempotencyHash: string;
  requestHash: string;
  /** PostgreSQL lease epoch; never expose this field over HTTP. */
  fencingToken?: string;
}

interface HunterRunStoreFile {
  version: 1;
  records: Record<string, HunterRunRecord>;
  idempotency: Record<string, string>;
}

export type RunAdmission =
  | { kind: "created" | "replay"; record: HunterRunRecord }
  | { kind: "conflict"; record: HunterRunRecord };

export interface HunterRunStore {
  readonly distributed?: boolean;
  readonly leaseHeartbeatMs?: number;
  admit(input: {
    idempotencyKey: string;
    ownerId: string;
    goal: string;
    requestMode: HunterRunRequestMode;
    locale: LanguageCode;
  }): Promise<RunAdmission>;
  get(missionId: string): Promise<HunterRunRecord | undefined>;
  update(missionId: string, update: (record: HunterRunRecord) => HunterRunRecord): Promise<HunterRunRecord>;
  completeRecovered(
    missionId: string,
    result: HunterRunResult,
    recoveryEvents: HunterTraceEvent[]
  ): Promise<HunterRunRecord>;
  claimAvailable?(ownerId: string, limit?: number): Promise<HunterRunRecord[]>;
  renewLease?(record: HunterRunRecord): Promise<boolean>;
  requestCancellation?(missionId: string): Promise<HunterRunRecord | undefined>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateRunIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new Error("Idempotency-Key must contain 8-200 safe ASCII characters");
  }
  return value;
}

export class FileHunterRunStore implements HunterRunStore {
  constructor(private readonly storePath: string) {}

  private async readStore(): Promise<HunterRunStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as HunterRunStoreFile;
      if (parsed.version !== 1 || !parsed.records || !parsed.idempotency) {
        throw new Error("Hunter run store has an unsupported format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {}, idempotency: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: HunterRunStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

  async admit(input: {
    idempotencyKey: string;
    ownerId: string;
    goal: string;
    requestMode: HunterRunRequestMode;
    locale: LanguageCode;
  }): Promise<RunAdmission> {
    const idempotencyKey = validateRunIdempotencyKey(input.idempotencyKey);
    const idempotencyHash = digest(idempotencyKey);
    const requestHash = digest(JSON.stringify({
      goal: input.goal,
      requestMode: input.requestMode,
      locale: input.locale
    }));
    return withLocalFileLock(this.storePath, async () => {
      const store = await this.readStore();
      const existingId = store.idempotency[idempotencyHash];
      if (existingId) {
        const existing = store.records[existingId];
        if (!existing) throw new Error("Hunter run store index is inconsistent");
        return { kind: existing.requestHash === requestHash ? "replay" : "conflict", record: existing };
      }
      const now = Date.now();
      const record: HunterRunRecord = {
        missionId: randomUUID(),
        goal: input.goal,
        requestMode: input.requestMode,
        locale: input.locale,
        status: "running",
        events: [],
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
        ownerId: input.ownerId,
        idempotencyHash,
        requestHash
      };
      store.records[record.missionId] = record;
      store.idempotency[idempotencyHash] = record.missionId;
      await this.writeStore(store);
      return { kind: "created", record };
    });
  }

  async get(missionId: string): Promise<HunterRunRecord | undefined> {
    return (await this.readStore()).records[missionId];
  }

  async update(
    missionId: string,
    update: (record: HunterRunRecord) => HunterRunRecord
  ): Promise<HunterRunRecord> {
    return withLocalFileLock(this.storePath, async () => {
      const store = await this.readStore();
      const current = store.records[missionId];
      if (!current) throw new Error(`Hunter run was not found: ${missionId}`);
      const next = { ...update(current), missionId, updatedAt: Date.now() };
      store.records[missionId] = next;
      await this.writeStore(store);
      return next;
    });
  }

  async completeRecovered(
    missionId: string,
    result: HunterRunResult,
    recoveryEvents: HunterTraceEvent[]
  ): Promise<HunterRunRecord> {
    if (result.missionId !== missionId) {
      throw new Error("Recovered result missionId does not match the durable run");
    }
    return this.update(missionId, (current) => {
      if (result.goal !== current.goal) {
        throw new Error("Recovered result goal does not match the durable run");
      }
      if (current.status === "running" || current.status === "cancelled") {
        throw new Error(`Cannot reconcile a ${current.status} durable run`);
      }
      if (current.status === "completed") {
        if (JSON.stringify(current.result) !== JSON.stringify(result)) {
          throw new Error("Durable run is already completed with a different result");
        }
        return current;
      }
      if (current.events.length + recoveryEvents.length > 2_000) {
        throw new Error("Recovered durable run exceeds the trace limit");
      }
      return {
        ...current,
        status: "completed",
        events: [...current.events, ...recoveryEvents],
        result,
        error: undefined
      };
    });
  }
}

export class PostgresHunterRunStore implements HunterRunStore {
  readonly distributed = true;
  readonly leaseHeartbeatMs: number;

  constructor(
    private readonly database: PostgresCoordinationStore,
    private readonly scope = "hunter-run",
    private readonly leaseMs = 30_000
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) {
      throw new Error("PostgreSQL Hunter run lease must be at least 1000 ms");
    }
    this.leaseHeartbeatMs = Math.max(500, Math.floor(leaseMs / 3));
  }

  private async mapRecord(run: Awaited<ReturnType<PostgresCoordinationStore["getRun"]>>): Promise<HunterRunRecord | undefined> {
    if (!run || run.scope !== this.scope) return undefined;
    const [events, idempotency] = await Promise.all([
      this.database.listRunEvents(run.missionId),
      this.database.listRunIdempotency(run.missionId)
    ]);
    if (!idempotency) throw new Error(`PostgreSQL run idempotency row is missing: ${run.missionId}`);
    const error = run.error && typeof run.error === "object"
      ? run.error as { code?: unknown; message?: unknown }
      : undefined;
    return {
      missionId: run.missionId,
      goal: run.goal,
      requestMode: run.requestMode === "commander" ? "commander" : "single",
      locale: run.locale === "zh-CN" ? "zh-CN" : "en-US",
      status: run.status === "created" ? "running" : run.status,
      events: events.map((event) => event.payload as HunterTraceEvent),
      ...(run.result === undefined ? {} : { result: run.result as HunterRunResult }),
      ...(error && typeof error.code === "string" && typeof error.message === "string"
        ? { error: { code: error.code, message: error.message } }
        : {}),
      cancelRequested: run.cancelRequested,
      createdAt: Date.parse(run.createdAt),
      updatedAt: Date.parse(run.updatedAt),
      ownerId: run.leaseOwner ?? run.ownerId,
      idempotencyHash: idempotency.keyHash,
      requestHash: idempotency.requestHash,
      fencingToken: run.fencingToken
    };
  }

  async admit(input: {
    idempotencyKey: string;
    ownerId: string;
    goal: string;
    requestMode: HunterRunRequestMode;
    locale: LanguageCode;
  }): Promise<RunAdmission> {
    const key = validateRunIdempotencyKey(input.idempotencyKey);
    const idempotencyHash = digest(key);
    const requestHash = digest(JSON.stringify({
      goal: input.goal,
      requestMode: input.requestMode,
      locale: input.locale
    }));
    const admission = await this.database.admitRun({
      scope: this.scope,
      keyHash: idempotencyHash,
      requestHash,
      ownerId: input.ownerId,
      goal: input.goal,
      requestMode: input.requestMode,
      locale: input.locale
    });
    if (admission.kind !== "created") {
      return { kind: admission.kind, record: (await this.mapRecord(admission.run))! };
    }
    const claimed = await this.database.claimRun(
      this.scope,
      admission.run.missionId,
      input.ownerId,
      this.leaseMs
    );
    if (!claimed) {
      const winner = await this.get(admission.run.missionId);
      if (!winner) throw new Error("PostgreSQL run disappeared after admission");
      return { kind: "replay", record: winner };
    }
    return { kind: "created", record: (await this.mapRecord(claimed))! };
  }

  async get(missionId: string): Promise<HunterRunRecord | undefined> {
    return this.mapRecord(await this.database.getRun(missionId));
  }

  async claimAvailable(ownerId: string, limit = 4): Promise<HunterRunRecord[]> {
    const claimed = await this.database.claimRuns(this.scope, ownerId, limit, this.leaseMs);
    return Promise.all(claimed.map((run) => this.mapRecord(run) as Promise<HunterRunRecord>));
  }

  async renewLease(record: HunterRunRecord): Promise<boolean> {
    if (!record.fencingToken) return false;
    return this.database.renewRunLease(
      record.missionId,
      record.ownerId,
      record.fencingToken,
      this.leaseMs
    );
  }

  async update(
    missionId: string,
    update: (record: HunterRunRecord) => HunterRunRecord
  ): Promise<HunterRunRecord> {
    const current = await this.get(missionId);
    if (!current) throw new Error(`Hunter run was not found: ${missionId}`);
    if (!current.fencingToken) throw new Error(`Hunter run has no active PostgreSQL lease: ${missionId}`);
    const next = { ...update(current), missionId };
    if (
      next.goal !== current.goal || next.requestMode !== current.requestMode ||
      next.locale !== current.locale || next.requestHash !== current.requestHash ||
      next.idempotencyHash !== current.idempotencyHash
    ) {
      throw new Error("Hunter run immutable fields cannot be changed");
    }
    if (next.events.length < current.events.length || current.events.some(
      (event, index) => JSON.stringify(event) !== JSON.stringify(next.events[index])
    )) {
      throw new Error("Hunter run events must be append-only");
    }
    if (next.cancelRequested && !current.cancelRequested) {
      await this.database.requestRunCancellation(missionId);
    }
    for (const event of next.events.slice(current.events.length)) {
      await this.database.appendRunEvent({
        missionId,
        workerId: current.ownerId,
        fencingToken: current.fencingToken,
        eventType: event.type,
        payload: event
      });
    }
    if (next.status !== "running" && current.status === "running") {
      await this.database.finishRun({
        missionId,
        workerId: current.ownerId,
        fencingToken: current.fencingToken,
        status: next.status,
        result: next.result,
        error: next.error
      });
    }
    const saved = await this.get(missionId);
    if (!saved) throw new Error(`Hunter run disappeared after update: ${missionId}`);
    return saved;
  }

  async requestCancellation(missionId: string): Promise<HunterRunRecord | undefined> {
    if (!await this.database.requestRunCancellation(missionId)) return this.get(missionId);
    return this.get(missionId);
  }

  async completeRecovered(
    missionId: string,
    result: HunterRunResult,
    recoveryEvents: HunterTraceEvent[]
  ): Promise<HunterRunRecord> {
    if (result.missionId !== missionId) throw new Error("Recovered result missionId does not match the durable run");
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        goal: string;
        status: HunterRunStatus | "created";
        result: HunterRunResult | null;
        next_event_sequence: string;
        fencing_token: string;
      }>("SELECT goal, status, result, next_event_sequence, fencing_token FROM runs WHERE mission_id = $1 FOR UPDATE", [missionId]);
      if (!selected.rowCount) throw new Error(`Hunter run was not found: ${missionId}`);
      const row = selected.rows[0];
      if (result.goal !== row.goal) throw new Error("Recovered result goal does not match the durable run");
      if (row.status === "running" || row.status === "created" || row.status === "cancelled") {
        throw new Error(`Cannot reconcile a ${row.status} durable run`);
      }
      if (row.status === "completed") {
        if (JSON.stringify(row.result) !== JSON.stringify(result)) {
          throw new Error("Durable run is already completed with a different result");
        }
        await client.query("COMMIT");
        return (await this.get(missionId))!;
      }
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM run_events WHERE mission_id = $1",
        [missionId]
      );
      if (Number(count.rows[0].count) + recoveryEvents.length > 2_000) {
        throw new Error("Recovered durable run exceeds the trace limit");
      }
      let sequence = BigInt(row.next_event_sequence);
      const fencingToken = BigInt(row.fencing_token) > 0n ? row.fencing_token : "1";
      for (const event of recoveryEvents) {
        await client.query(`
          INSERT INTO run_events(mission_id, sequence, event_type, payload, fencing_token)
          VALUES ($1, $2, $3, $4::jsonb, $5)
        `, [missionId, sequence.toString(), event.type, JSON.stringify(event), fencingToken]);
        sequence += 1n;
      }
      await client.query(`
        UPDATE runs SET status = 'completed', result = $2::jsonb, error = NULL,
          lease_owner = NULL, lease_expires_at = NULL, next_event_sequence = $3,
          fencing_token = GREATEST(fencing_token, 1), version = version + 1,
          updated_at = clock_timestamp()
        WHERE mission_id = $1
      `, [missionId, JSON.stringify(result), sequence.toString()]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.get(missionId))!;
  }
}

export function publicRunRecord(record: HunterRunRecord): Omit<
  HunterRunRecord,
  "ownerId" | "idempotencyHash" | "requestHash" | "fencingToken"
> {
  const {
    ownerId: _ownerId,
    idempotencyHash: _key,
    requestHash: _request,
    fencingToken: _fencingToken,
    ...safe
  } = record;
  return safe;
}

export async function openHunterRunStore(
  storePath: string,
  scope = "hunter-run",
  leaseMs = 30_000
): Promise<HunterRunStore> {
  const postgres = await getProcessPostgresStore("agora-hunter");
  return postgres
    ? new PostgresHunterRunStore(postgres, scope, leaseMs)
    : new FileHunterRunStore(storePath);
}
