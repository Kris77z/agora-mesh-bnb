import { readFile } from "node:fs/promises";
import {
  buildCaip2Network,
  filterServicesByPaymentMode,
  fetchAdvertisedServices,
  listDynamicServices as listDynamicServicesFromStore,
  type ServiceInfo,
  type ServiceRegistry
} from "@rebel/shared";
import { hunterConfig } from "../config.js";
import { HunterError } from "../errors.js";

function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

function mergeServices(primary: ServiceInfo[], secondary: ServiceInfo[]): ServiceInfo[] {
  const byId = new Map<string, ServiceInfo>();
  for (const item of secondary) {
    byId.set(item.id, item);
  }
  for (const item of primary) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    byId.set(item.id, {
      ...existing,
      ...item,
      taskType: item.taskType ?? existing.taskType,
      skills: item.skills ?? existing.skills,
      reputation: item.reputation ?? existing.reputation
    });
  }
  return [...byId.values()];
}

export { isX402CompatibleService, filterServicesByPaymentMode } from "@rebel/shared";

async function discoverAdvertisedServices(staticServices: ServiceInfo[]): Promise<ServiceInfo[]> {
  let dynamicStoreServices: ServiceInfo[] = [];
  try {
    dynamicStoreServices = await listDynamicServicesFromStore();
  } catch {
    dynamicStoreServices = [];
  }

  let registryServiceServices: ServiceInfo[] = [];
  try {
    const response = await fetch(`${normalizeEndpoint(hunterConfig.registryServiceUrl)}/services`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (response.ok) {
      const payload = (await response.json()) as { services?: ServiceInfo[] } | undefined;
      if (Array.isArray(payload?.services)) {
        registryServiceServices = payload.services;
      }
    }
  } catch {
    registryServiceServices = [];
  }

  const staticEndpoints = staticServices.map((item) => item.endpoint);
  const dynamicEndpoints = dynamicStoreServices.map((item) => item.endpoint);
  const registryEndpoints = registryServiceServices.map((item) => item.endpoint);
  const endpointCandidates = [
    ...new Set([
      ...hunterConfig.discoveryEndpoints,
      ...staticEndpoints,
      ...dynamicEndpoints,
      ...registryEndpoints
    ])
  ];
  if (endpointCandidates.length === 0) {
    return mergeServices(registryServiceServices, dynamicStoreServices);
  }

  const advertised = await Promise.all(endpointCandidates.map((endpoint) => fetchAdvertisedServices(endpoint, {
    allowLocal: hunterConfig.discoverySecurity.allowLocalEndpoints,
    allowedHosts: hunterConfig.discoverySecurity.allowedHosts
  })));
  const remoteServices = advertised.flat();
  if (hunterConfig.x402.enabled) return remoteServices;
  return mergeServices(remoteServices, mergeServices(registryServiceServices, dynamicStoreServices));
}

export async function discoverServices(): Promise<ServiceInfo[]> {
  let content: string;
  try {
    content = await readFile(hunterConfig.registryPath, "utf8");
  } catch (error) {
    throw new HunterError(500, "REGISTRY_READ_FAILED", "Failed to read service registry", {
      path: hunterConfig.registryPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  let parsed: ServiceRegistry;
  try {
    parsed = JSON.parse(content) as ServiceRegistry;
  } catch (error) {
    throw new HunterError(500, "REGISTRY_INVALID_JSON", "Service registry JSON is invalid", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  if (!Array.isArray(parsed.services)) {
    throw new HunterError(500, "REGISTRY_INVALID_FORMAT", "Service registry must contain services[]");
  }

  const advertised = await discoverAdvertisedServices(parsed.services);
  const activeNetwork = buildCaip2Network(hunterConfig.chainId);
  const liveIds = new Set(advertised.map((service) => service.id));
  const networkServices = mergeServices(advertised, parsed.services).filter(
    (service) => !hunterConfig.x402.enabled || liveIds.has(service.id)
  ).filter(
    (service) => service.network === activeNetwork
  );
  return filterServicesByPaymentMode(networkServices, {
    x402Enabled: hunterConfig.x402.enabled,
    chainId: hunterConfig.chainId
  });
}
