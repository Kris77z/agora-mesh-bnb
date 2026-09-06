import type { ServiceInfo } from "./types.js";
import { assertSafeServiceEndpoint } from "./http-security.js";

const EVM_ADDRESS = /^0x[\da-f]{40}$/i;
export interface PaymentDiscoveryPolicy { x402Enabled: boolean; chainId: number }
export function isX402CompatibleService(service: ServiceInfo, chainId: number): boolean {
  return Boolean(service.availability?.available !== false &&
    Array.isArray(service.paymentRails) && service.paymentRails.includes("x402") &&
    service.network === `eip155:${chainId}` && service.asset?.chainId === chainId &&
    service.asset.kind === "erc20" && typeof service.asset.address === "string" && EVM_ADDRESS.test(service.asset.address) &&
    typeof service.provider === "string" && EVM_ADDRESS.test(service.provider) && !/^0x0{40}$/i.test(service.provider) &&
    typeof service.price === "string" && /^\d+$/.test(service.price) && BigInt(service.price) > 0n);
}
export function filterServicesByPaymentMode(services: ServiceInfo[], policy: PaymentDiscoveryPolicy): ServiceInfo[] {
  return policy.x402Enabled ? services.filter((service) => isX402CompatibleService(service, policy.chainId)) : services;
}

/** All capabilities at one endpoint, not just identity.service (the primary capability). */
export function advertisedServices(payload: unknown, endpoint: string): ServiceInfo[] {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as { service?: unknown; services?: unknown };
  const candidates = Array.isArray(value.services) ? value.services : [value.service];
  return candidates.filter((candidate): candidate is ServiceInfo => {
    if (!candidate || typeof candidate !== "object") return false;
    const service = candidate as ServiceInfo;
    return [service.id, service.name, service.description, service.endpoint, service.network, service.provider, service.price]
      .every((field) => typeof field === "string") &&
      service.endpoint.replace(/\/$/, "") === endpoint.replace(/\/$/, "") &&
      EVM_ADDRESS.test(service.provider) && /^\d+$/.test(service.price) &&
      (service.skills === undefined || Array.isArray(service.skills) && service.skills.every((skill) => typeof skill === "string")) &&
      service.availability?.available !== false;
  });
}

export async function fetchAdvertisedServices(endpoint: string, security: {
  allowLocal: boolean; allowedHosts: string[]
}): Promise<ServiceInfo[]> {
  try {
    await assertSafeServiceEndpoint(endpoint, security);
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/identity`, {
      signal: AbortSignal.timeout(1500), redirect: "error"
    });
    return response.ok ? advertisedServices(await response.json(), endpoint) : [];
  } catch { return []; }
}
