import { readFile } from "node:fs/promises";
import {
  enrichServicesWithReputation,
  filterServicesByPaymentMode,
  fetchAdvertisedServices,
  listDynamicServices,
  rankServiceOffers,
  type RankedServiceOffer,
  type ServiceInfo,
  type ServiceRegistry
} from "@rebel/shared";
import { registryConfig } from "./config.js";

export interface ServiceCatalogFilter {
  category?: string;
  rail?: string;
  chainId?: number;
}

export function mergeServiceCatalog(seed: ServiceInfo[], dynamic: ServiceInfo[]): ServiceInfo[] {
  const byId = new Map(seed.map((service) => [service.id, service]));
  for (const service of dynamic) {
    const fallback = byId.get(service.id);
    byId.set(service.id, fallback ? {
      ...fallback,
      ...service,
      taskType: service.taskType ?? fallback.taskType,
      skills: service.skills ?? fallback.skills,
      asset: service.asset ?? fallback.asset,
      agentId: service.agentId ?? fallback.agentId,
      paymentRails: service.paymentRails ?? fallback.paymentRails,
      averageLatencyMs: service.averageLatencyMs ?? fallback.averageLatencyMs,
      offerVersion: service.offerVersion ?? fallback.offerVersion,
      reputation: service.reputation ?? fallback.reputation
    } : service);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function filterServiceCatalog(
  services: ServiceInfo[],
  filter: ServiceCatalogFilter
): ServiceInfo[] {
  const category = filter.category?.trim().toLowerCase();
  const rail = filter.rail?.trim().toLowerCase();
  return services.filter((service) => {
    const matchesCategory = !category ||
      service.taskType?.toLowerCase() === category ||
      service.skills?.some((skill) => skill.toLowerCase() === category);
    const matchesRail = !rail || service.paymentRails?.some((item) => item === rail);
    const matchesChain = !filter.chainId || service.asset?.chainId === filter.chainId ||
      service.network === `eip155:${filter.chainId}`;
    return Boolean(matchesCategory && matchesRail && matchesChain);
  });
}

async function loadSeedServices(): Promise<ServiceInfo[]> {
  const raw = await readFile(registryConfig.registryPath, "utf8");
  const parsed = JSON.parse(raw) as ServiceRegistry;
  if (!Array.isArray(parsed.services)) {
    throw new Error("Static service registry must contain services[]");
  }
  return parsed.services;
}

export async function loadCatalogServices(
  filter: ServiceCatalogFilter = {}
): Promise<ServiceInfo[]> {
  const [seed, dynamic] = await Promise.all([
    loadSeedServices(),
    listDynamicServices().catch(() => [] as ServiceInfo[])
  ]);
  const merged = mergeServiceCatalog(seed, dynamic);
  const enriched = await enrichServicesWithReputation(merged);
  return filterServiceCatalog(enriched, filter);
}

export async function compareCatalogServices(input: {
  serviceIds?: string[];
  taskType?: string;
  requiredSkills?: string[];
}): Promise<RankedServiceOffer[]> {
  const catalog = await loadCatalogServices();
  const eligible = filterServicesByPaymentMode(catalog, registryConfig);
  const live = registryConfig.x402Enabled ? (await Promise.all(
    [...new Set(eligible.map((service) => service.endpoint))].map((endpoint) => fetchAdvertisedServices(endpoint, {
      allowLocal: registryConfig.httpSecurity.allowLocalServiceEndpoints,
      allowedHosts: registryConfig.httpSecurity.allowedServiceHosts
    }))
  )).flat() : eligible;
  const liveIds = new Set(live.map((service) => service.id));
  const services = filterServicesByPaymentMode(mergeServiceCatalog(eligible, live), registryConfig)
    .filter((service) => liveIds.has(service.id) && service.network === `eip155:${registryConfig.chainId}`);
  const selectedIds = new Set((input.serviceIds ?? []).map((id) => id.trim()).filter(Boolean));
  const candidates = services.filter((service) => {
    if (selectedIds.size > 0) {
      return selectedIds.has(service.id) && (!input.taskType || service.taskType === input.taskType);
    }
    return !input.taskType || service.taskType === input.taskType;
  });
  return rankServiceOffers(candidates, {
    taskType: input.taskType,
    requiredSkills: input.requiredSkills
  });
}
