export interface MarketplaceReputation {
  score: number;
  count: number;
  trend: 'up' | 'down' | 'stable';
  recentScores: number[];
  lastUsedAt: number;
  qualified: boolean;
}

export interface MarketplaceService {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  taskType?: string;
  skills?: string[];
  price: string;
  currency: string;
  asset?: {
    chainId: number;
    kind: 'native' | 'erc20';
    address?: `0x${string}`;
    symbol: string;
    decimals: number;
  };
  agentId?: string;
  paymentRails?: Array<'legacy-native' | 'x402' | 'erc8183'>;
  averageLatencyMs?: number;
  network: string;
  provider: string;
  reputation?: MarketplaceReputation;
}

export interface ServiceRanking {
  rank: number;
  service: MarketplaceService;
  score: number;
  scores: {
    capability: number;
    reputation: number;
    price: number;
    latency: number;
  };
  weights: {
    capability: number;
    reputation: number;
    price: number;
    latency: number;
  };
  reason: string;
}

export interface MarketplaceAgentIdentity {
  agentId: string;
  name: string;
  description: string;
  walletAddress: string;
  trustModels: string[];
  active: boolean;
}
