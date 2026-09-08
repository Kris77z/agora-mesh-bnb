import { apiBase } from '@/lib/api-config';
import type {
  MarketplaceAgentIdentity,
  MarketplaceService,
  ServiceRanking,
} from '@/types/marketplace';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `Registry request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function listMarketplaceServices(category?: string): Promise<{ services: MarketplaceService[]; count: number }> {
  const query = new URLSearchParams({ chainId: '97' });
  if (category) query.set('category', category);
  return requestJson(`${apiBase.registry}/services?${query.toString()}`);
}

export function getMarketplaceService(serviceId: string): Promise<{ service: MarketplaceService }> {
  return requestJson(`${apiBase.registry}/services/${encodeURIComponent(serviceId)}`);
}

export function getMarketplaceAgent(agentId: string): Promise<{
  identity: MarketplaceAgentIdentity;
  services: MarketplaceService[];
}> {
  return requestJson(`${apiBase.registry}/agents/${encodeURIComponent(agentId)}`);
}

export type RankingPreference = 'balanced' | 'reputation-first' | 'price-first';

export function compareMarketplaceServices(input: {
  serviceIds: string[];
  taskType?: string;
  requiredSkills?: string[];
  preference?: RankingPreference;
}): Promise<{ rankings: ServiceRanking[]; count: number; preference?: RankingPreference }> {
  return requestJson(`${apiBase.registry}/services/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
