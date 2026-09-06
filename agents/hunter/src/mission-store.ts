import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HunterTraceEvent } from "@rebel/shared";
import type { HunterRunResult } from "./run-types.js";
import { getProcessPostgresStore, withLocalFileLock } from "@rebel/shared";
import type { PostgresCoordinationStore } from "@rebel/shared";

export type StoredMissionStatus = "completed" | "failed";

export interface StoredHunterMission {
  missionId: string;
  goal: string;
  chainId: number;
  authorityId?: string;
  mode: "scripted" | "react" | "commander";
  status: StoredMissionStatus;
  source: "live-run" | "recovered-evidence";
  events: HunterTraceEvent[];
  result?: HunterRunResult;
  error?: { code?: string; message: string };
  createdAt: number;
  completedAt: number;
}

export interface StoredMissionSummary {
  missionId: string;
  goal: string;
  mode: StoredHunterMission["mode"];
  status: StoredMissionStatus;
  source: StoredHunterMission["source"];
  serviceId?: string;
  score?: number;
  createdAt: number;
  completedAt: number;
}

interface MissionStoreFile {
  version: 1;
  records: Record<string, StoredHunterMission>;
}

export interface HunterMissionStore {
  get(missionId: string): Promise<StoredHunterMission | undefined>;
  list(): Promise<StoredMissionSummary[]>;
  listRecords(): Promise<StoredHunterMission[]>;
  save(record: StoredHunterMission): Promise<void>;
}

function summarize(record: StoredHunterMission): StoredMissionSummary {
  return {
    missionId: record.missionId,
    goal: record.goal,
    mode: record.mode,
    status: record.status,
    source: record.source,
    serviceId: record.result?.service.id,
    score: record.result?.evaluation.score,
    createdAt: record.createdAt,
    completedAt: record.completedAt
  };
}

export class FileHunterMissionStore implements HunterMissionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readStore(): Promise<MissionStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as MissionStoreFile;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("Hunter mission store has an unsupported format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: MissionStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

  get(missionId: string): Promise<StoredHunterMission | undefined> {
    return this.serialized(async () => (await this.readStore()).records[missionId]);
  }

  list(): Promise<StoredMissionSummary[]> {
    return this.serialized(async () => Object.values((await this.readStore()).records)
      .sort((left, right) => right.completedAt - left.completedAt)
      .map(summarize));
  }

  listRecords(): Promise<StoredHunterMission[]> {
    return this.serialized(async () => Object.values((await this.readStore()).records)
      .sort((left, right) => right.completedAt - left.completedAt));
  }

  save(record: StoredHunterMission): Promise<void> {
    return this.serialized(async () => {
      await withLocalFileLock(this.storePath, async () => {
        const store = await this.readStore();
        store.records[record.missionId] = record;
        await this.writeStore(store);
      });
    });
  }
}

interface PostgresMissionRow {
  mission_id: string;
  goal: string;
  chain_id: string;
  authority_id: string | null;
  mode: StoredHunterMission["mode"];
  status: StoredHunterMission["status"];
  source: StoredHunterMission["source"];
  events: HunterTraceEvent[];
  result: HunterRunResult | null;
  error: { code?: string; message: string } | null;
  created_at: Date | string;
  completed_at: Date | string;
}

function mapPostgresMission(row: PostgresMissionRow): StoredHunterMission {
  return {
    missionId: row.mission_id,
    goal: row.goal,
    chainId: Number(row.chain_id),
    ...(row.authority_id ? { authorityId: row.authority_id } : {}),
    mode: row.mode,
    status: row.status,
    source: row.source,
    events: row.events,
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: new Date(row.created_at).getTime(),
    completedAt: new Date(row.completed_at).getTime()
  };
}

export class PostgresHunterMissionStore implements HunterMissionStore {
  constructor(private readonly database: PostgresCoordinationStore) {}

  async get(missionId: string): Promise<StoredHunterMission | undefined> {
    const result = await this.database.pool.query<PostgresMissionRow>(
      "SELECT * FROM missions WHERE mission_id = $1",
      [missionId]
    );
    return result.rows[0] ? mapPostgresMission(result.rows[0]) : undefined;
  }

  async listRecords(): Promise<StoredHunterMission[]> {
    const result = await this.database.pool.query<PostgresMissionRow>(
      "SELECT * FROM missions ORDER BY completed_at DESC, mission_id"
    );
    return result.rows.map(mapPostgresMission);
  }

  async list(): Promise<StoredMissionSummary[]> {
    return (await this.listRecords()).map(summarize);
  }

  async save(record: StoredHunterMission): Promise<void> {
    await this.database.pool.query(`
      INSERT INTO missions (
        mission_id, goal, chain_id, authority_id, mode, status, source,
        events, result, error, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
      ON CONFLICT (mission_id) DO UPDATE SET
        goal = EXCLUDED.goal,
        chain_id = EXCLUDED.chain_id,
        authority_id = EXCLUDED.authority_id,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        events = EXCLUDED.events,
        result = EXCLUDED.result,
        error = EXCLUDED.error,
        created_at = EXCLUDED.created_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = clock_timestamp()
    `, [
      record.missionId, record.goal, record.chainId, record.authorityId ?? null,
      record.mode, record.status, record.source, JSON.stringify(record.events),
      record.result === undefined ? null : JSON.stringify(record.result),
      record.error === undefined ? null : JSON.stringify(record.error),
      new Date(record.createdAt), new Date(record.completedAt)
    ]);
  }
}

export async function openHunterMissionStore(storePath: string): Promise<HunterMissionStore> {
  const postgres = await getProcessPostgresStore("agora-hunter");
  return postgres
    ? new PostgresHunterMissionStore(postgres)
    : new FileHunterMissionStore(storePath);
}

export function readMissionIdFromEvents(events: HunterTraceEvent[]): string | undefined {
  for (const event of events) {
    if (!event.data || typeof event.data !== "object") continue;
    const missionId = (event.data as { missionId?: unknown }).missionId;
    if (typeof missionId === "string" && missionId.trim()) return missionId.trim();
  }
  return undefined;
}

export function readEventTimestamp(event: HunterTraceEvent | undefined, fallback: number): number {
  if (!event) return fallback;
  const parsed = Date.parse(event.at);
  return Number.isFinite(parsed) ? parsed : fallback;
}
