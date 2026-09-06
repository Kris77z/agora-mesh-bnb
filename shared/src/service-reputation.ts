import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceInfo, ServiceReputation, ServiceReputationTrend } from "./types.js";
import { getProcessPostgresStore } from "./storage-backend.js";

export interface ServiceFeedbackEntry {
  serviceId: string;
  hunterId: string;
  missionId: string;
  score: number;
  taskType: string;
  comment?: string;
  timestamp: number;
}

interface ServiceFeedbackStore {
  feedback: ServiceFeedbackEntry[];
}

const defaultStorePath = path.resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.SERVICE_FEEDBACK_STORE_PATH ?? "./registry/service-feedback-store.json"
);

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeText(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readStore(): Promise<ServiceFeedbackStore> {
  try {
    const content = await readFile(defaultStorePath, "utf8");
    const parsed = JSON.parse(content) as ServiceFeedbackStore;
    if (!Array.isArray(parsed.feedback)) {
      return { feedback: [] };
    }
    return { feedback: parsed.feedback };
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return { feedback: [] };
    }
    throw error;
  }
}

async function writeStore(payload: ServiceFeedbackStore): Promise<void> {
  await mkdir(path.dirname(defaultStorePath), { recursive: true });
  await writeFile(defaultStorePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readFeedbackEntries(serviceId?: string): Promise<ServiceFeedbackEntry[]> {
  const postgres = await getProcessPostgresStore("agora-service-reputation");
  if (!postgres) {
    const entries = (await readStore()).feedback;
    return serviceId === undefined
      ? entries
      : entries.filter((item) => item.serviceId === serviceId.trim());
  }
  return (await postgres.listServiceFeedback(serviceId?.trim())).map((row) => {
    const evidence = row.evidence && typeof row.evidence === "object"
      ? row.evidence as { taskType?: unknown; comment?: unknown }
      : {};
    return {
      serviceId: row.serviceId,
      hunterId: row.agentId,
      missionId: row.missionId,
      score: row.value,
      taskType: typeof evidence.taskType === "string" ? evidence.taskType : "unknown",
      ...(typeof evidence.comment === "string" ? { comment: evidence.comment } : {}),
      timestamp: Math.floor(Date.parse(row.createdAt) / 1_000)
    };
  });
}

export async function appendServiceFeedbackEntry(input: {
  serviceId: string;
  hunterId: string;
  missionId: string;
  score: number;
  taskType: string;
  comment?: string;
  timestamp?: number;
}): Promise<ServiceFeedbackEntry> {
  const entry: ServiceFeedbackEntry = {
    serviceId: input.serviceId.trim(),
    hunterId: input.hunterId.trim(),
    missionId: input.missionId.trim(),
    score: clampScore(input.score),
    taskType: normalizeText(input.taskType) ?? "unknown",
    comment: normalizeText(input.comment),
    timestamp:
      typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
        ? Math.floor(input.timestamp)
        : Math.floor(Date.now() / 1000)
  };
  const postgres = await getProcessPostgresStore("agora-service-reputation");
  if (postgres) {
    await postgres.appendServiceFeedback({
      serviceId: entry.serviceId,
      agentId: entry.hunterId,
      missionId: entry.missionId,
      value: entry.score,
      evidence: { taskType: entry.taskType, ...(entry.comment ? { comment: entry.comment } : {}) },
      createdAt: new Date(entry.timestamp * 1_000)
    });
    return entry;
  }
  const store = await readStore();
  store.feedback.push(entry);
  await writeStore(store);
  return entry;
}

export async function listServiceFeedbackEntries(serviceId: string): Promise<ServiceFeedbackEntry[]> {
  return readFeedbackEntries(serviceId);
}

function computeTrend(values: number[]): ServiceReputationTrend {
  if (values.length < 4) {
    return "stable";
  }
  const recent = values.slice(-3);
  const previous = values.slice(-6, -3);
  if (previous.length === 0) {
    return "stable";
  }
  const recentAvg = recent.reduce((sum, item) => sum + item, 0) / recent.length;
  const previousAvg = previous.reduce((sum, item) => sum + item, 0) / previous.length;
  const delta = recentAvg - previousAvg;
  if (delta >= 5) {
    return "up";
  }
  if (delta <= -5) {
    return "down";
  }
  return "stable";
}

function computeWeightedAverageScore(entries: ServiceFeedbackEntry[], now: number): number {
  if (entries.length === 0) {
    return 0;
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of entries) {
    const ageSeconds = Math.max(0, now - item.timestamp);
    const ageDays = ageSeconds / 86400;
    // Half-life ~= 14 days
    const decayWeight = Math.pow(0.5, ageDays / 14);
    weightedSum += item.score * decayWeight;
    weightTotal += decayWeight;
  }
  if (weightTotal <= 0) {
    return 0;
  }
  return weightedSum / weightTotal;
}

function buildServiceReputation(
  entries: ServiceFeedbackEntry[],
  now: number,
  minimumSamples: number
): ServiceReputation | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const recentEntries = sorted.slice(-5);
  const recentScores = recentEntries.map((item) => clampScore(item.score));
  const weightedScore100 = computeWeightedAverageScore(sorted, now);
  const weightedScore5 = Math.max(0, Math.min(5, weightedScore100 / 20));
  const last = sorted[sorted.length - 1];
  return {
    score: Number(weightedScore5.toFixed(2)),
    count: sorted.length,
    trend: computeTrend(sorted.map((item) => item.score)),
    recentScores,
    lastUsedAt: last ? last.timestamp : now,
    qualified: sorted.length >= minimumSamples
  };
}

export async function getServiceReputation(serviceId: string, input: {
  now?: number;
  minimumSamples?: number;
} = {}): Promise<ServiceReputation | undefined> {
  const entries = await listServiceFeedbackEntries(serviceId);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const minimumSamples = input.minimumSamples ?? 3;
  return buildServiceReputation(entries, now, minimumSamples);
}

export async function getServiceReputationMap(input: {
  now?: number;
  minimumSamples?: number;
} = {}): Promise<Map<string, ServiceReputation>> {
  const entries = await readFeedbackEntries();
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const minimumSamples = input.minimumSamples ?? 3;
  const grouped = new Map<string, ServiceFeedbackEntry[]>();
  for (const item of entries) {
    const key = item.serviceId.trim();
    if (!key) {
      continue;
    }
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  const result = new Map<string, ServiceReputation>();
  for (const [serviceId, entries] of grouped.entries()) {
    const summary = buildServiceReputation(entries, now, minimumSamples);
    if (summary) {
      result.set(serviceId, summary);
    }
  }
  return result;
}

export async function enrichServicesWithReputation(
  services: ServiceInfo[],
  input: {
    minimumSamples?: number;
  } = {}
): Promise<ServiceInfo[]> {
  const map = await getServiceReputationMap({ minimumSamples: input.minimumSamples });
  return services.map((service) => ({
    ...service,
    reputation: map.get(service.id) ?? service.reputation
  }));
}
