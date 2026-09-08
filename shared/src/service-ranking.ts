import type { ServiceInfo } from "./types.js";

export interface ServiceRankingWeights {
  capability: number;
  reputation: number;
  price: number;
  latency: number;
}

export interface ServiceRankingContext {
  taskType?: string;
  requiredSkills?: string[];
  reputationScores?: Map<string, number>;
  weights?: Partial<ServiceRankingWeights>;
}

export interface RankedServiceOffer {
  rank: number;
  service: ServiceInfo;
  score: number;
  scores: {
    capability: number;
    reputation: number;
    price: number;
    latency: number;
  };
  weights: ServiceRankingWeights;
  reason: string;
}

export const DEFAULT_SERVICE_RANKING_WEIGHTS: ServiceRankingWeights = {
  capability: 0.35,
  reputation: 0.3,
  price: 0.2,
  latency: 0.15
};

export const SERVICE_RANKING_PREFERENCES = {
  balanced: DEFAULT_SERVICE_RANKING_WEIGHTS,
  "reputation-first": { capability: 0.3, reputation: 0.45, price: 0.1, latency: 0.15 },
  "price-first": { capability: 0.3, reputation: 0.1, price: 0.45, latency: 0.15 }
} as const satisfies Record<string, ServiceRankingWeights>;

export type ServiceRankingPreference = keyof typeof SERVICE_RANKING_PREFERENCES;

export function isServiceRankingPreference(value: unknown): value is ServiceRankingPreference {
  return typeof value === "string" && value in SERVICE_RANKING_PREFERENCES;
}

export function resolveServiceRankingPreference(preference?: ServiceRankingPreference): ServiceRankingWeights {
  return SERVICE_RANKING_PREFERENCES[preference ?? "balanced"];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeWeights(overrides: Partial<ServiceRankingWeights> = {}): ServiceRankingWeights {
  const merged = { ...DEFAULT_SERVICE_RANKING_WEIGHTS, ...overrides };
  const entries = Object.entries(merged) as Array<[keyof ServiceRankingWeights, number]>;
  if (entries.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Service ranking weights must be finite non-negative numbers");
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) {
    throw new Error("Service ranking weights must have a positive total");
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total])) as unknown as ServiceRankingWeights;
}

export function getServiceReputationScore(service: ServiceInfo): number {
  const reputation = service.reputation;
  if (!reputation) {
    return 0;
  }
  let normalized = reputation.score * 20;
  if (reputation.trend === "down") {
    normalized -= 8;
  } else if (reputation.trend === "up") {
    normalized += 3;
  }
  if (reputation.count < 3) {
    normalized = Math.max(normalized, 55);
  }
  return Math.max(0, Math.min(100, Number(normalized.toFixed(2))));
}

function capabilityScore(service: ServiceInfo, taskType?: string, requiredSkills: string[] = []): number {
  const normalizedSkills = new Set((service.skills ?? []).map((skill) => skill.toLowerCase()));
  const normalizedRequired = [...new Set(requiredSkills.map((skill) => skill.trim().toLowerCase()).filter(Boolean))];
  const taskMatch = taskType ? service.taskType === taskType : undefined;
  const skillMatch = normalizedRequired.length > 0
    ? normalizedRequired.filter((skill) => normalizedSkills.has(skill)).length / normalizedRequired.length
    : undefined;

  if (taskMatch === undefined && skillMatch === undefined) {
    return 0.5;
  }
  if (taskMatch !== undefined && skillMatch !== undefined) {
    return clampScore((taskMatch ? 0.7 : 0) + skillMatch * 0.3);
  }
  return taskMatch !== undefined ? (taskMatch ? 1 : 0) : clampScore(skillMatch ?? 0);
}

function normalizedInverse(value: bigint, min: bigint, max: bigint): number {
  if (max === min) {
    return 1;
  }
  return Number(((max - value) * 10_000n) / (max - min)) / 10_000;
}

function latencyScore(service: ServiceInfo, knownLatencies: number[]): number {
  const latency = service.averageLatencyMs;
  if (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0) {
    return 0.5;
  }
  const min = Math.min(...knownLatencies);
  const max = Math.max(...knownLatencies);
  if (min === max) {
    return 1;
  }
  return clampScore((max - latency) / (max - min));
}

function formatReason(scores: RankedServiceOffer["scores"]): string {
  const labels: Array<[keyof typeof scores, string]> = [
    ["capability", "capability match"],
    ["reputation", "reputation"],
    ["price", "price"],
    ["latency", "latency"]
  ];
  const strongest = labels
    .map(([key, label]) => ({ label, value: scores[key] }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 2)
    .map((item) => `${item.label} ${Math.round(item.value * 100)}%`);
  return `Selected by ${strongest.join(" and ")}`;
}

export function rankServiceOffers(
  services: ServiceInfo[],
  context: ServiceRankingContext = {}
): RankedServiceOffer[] {
  if (services.length === 0) {
    return [];
  }
  const weights = normalizeWeights(context.weights);
  const prices = services.map((service) => {
    if (!/^\d+$/.test(service.price)) {
      throw new Error(`Invalid service price for ${service.id}`);
    }
    return BigInt(service.price);
  });
  const minPrice = prices.reduce((min, value) => value < min ? value : min, prices[0]);
  const maxPrice = prices.reduce((max, value) => value > max ? value : max, prices[0]);
  const knownLatencies = services
    .map((service) => service.averageLatencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);

  const ranked = services.map((service, index): Omit<RankedServiceOffer, "rank"> => {
    const scores = {
      capability: capabilityScore(service, context.taskType, context.requiredSkills),
      reputation: clampScore(
        (context.reputationScores?.get(service.id) ?? getServiceReputationScore(service)) / 100
      ),
      price: normalizedInverse(prices[index], minPrice, maxPrice),
      latency: knownLatencies.length > 0 ? latencyScore(service, knownLatencies) : 0.5
    };
    const score =
      scores.capability * weights.capability +
      scores.reputation * weights.reputation +
      scores.price * weights.price +
      scores.latency * weights.latency;
    return {
      service,
      score: Number(score.toFixed(4)),
      scores,
      weights,
      reason: formatReason(scores)
    };
  });

  return ranked
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      const leftPrice = BigInt(left.service.price);
      const rightPrice = BigInt(right.service.price);
      if (leftPrice !== rightPrice) {
        return leftPrice < rightPrice ? -1 : 1;
      }
      return left.service.id.localeCompare(right.service.id);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
