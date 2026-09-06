/**
 * Agent types aligned with Hunter backend (react-engine.ts)
 * 
 * The `done` SSE event sends a HunterRunResult which nests actual content
 * inside `execution.result`, not at the top level.
 */

export interface AgentEvent {
  type: string;
  at: string;
  data?: unknown;
}

export type LanguageCode = 'zh-CN' | 'en-US';
export const DEFAULT_LANGUAGE_CODE: LanguageCode = 'en-US';

export type RunRequestMode = 'single' | 'commander';

export interface AssetRef {
  chainId: number;
  kind: 'native' | 'erc20';
  address?: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface Money {
  asset: AssetRef;
  amount: string;
}

export type ServiceTaskType =
  | 'content-generation'
  | 'smart-contract-audit'
  | 'finding-verification'
  | 'onchain-investigation'
  | 'defi-analysis'
  | 'gas-optimization'
  | 'token-scan'
  | 'tx-decode'
  | 'abi-interact'
  | 'yield-search';

/** Matches ExecuteSuccessResponse from backend */
export interface ExecutionResult {
  result: string;
  receipt: {
    requestHash: string;
    resultHash: string;
    provider: string;
    timestamp: number;
    signature: string;
  };
  payment: {
    status: string;
    transaction: string;
    network: string;
    rail?: 'x402';
    payer?: string;
    recipient?: string;
    amount?: Money;
    transferMethod?: string;
  };
}

export type OnchainRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface OnchainRiskReport {
  version: 1;
  chainId: number;
  target: {
    address: string;
    classification: 'eoa' | 'contract' | 'erc20';
    bytecodeSize: number;
    bytecodeHash?: string;
  };
  observedAt: string;
  blockNumber: number;
  sources: Array<{
    kind: 'rpc';
    endpoint: string;
    methods: string[];
    observedAt: string;
  }>;
  facts: {
    nativeBalanceWei: string;
    transactionCount: string;
    token?: {
      name?: string;
      symbol?: string;
      decimals?: number;
      totalSupply?: string;
    };
    ownership: {
      owner?: string;
      probe: 'owner()' | 'getOwner()' | 'unavailable';
      renounced?: boolean;
    };
    proxy: {
      standard: 'eip-1967';
      implementation?: string;
      admin?: string;
      implementationBytecodeSize?: number;
      implementationBytecodeHash?: string;
    };
  };
  riskSignals: Array<{
    id: string;
    severity: 'info' | OnchainRiskLevel;
    title: string;
    evidence: string;
    confidence: number;
  }>;
  riskScore: number;
  riskLevel: OnchainRiskLevel;
  coverage: Record<string, 'measured' | 'partial' | 'not-measured' | 'not-applicable' | 'unavailable'>;
  limitations: string[];
  recommendation: string;
}

export interface FindingVerification {
  findingId: string;
  status: 'confirmed' | 'rejected' | 'partial' | 'inconclusive' | 'missed';
  method: 'static-analysis' | 'ast-rule' | 'llm-assisted';
  confidence: number;
  evidence: {
    tool?: string;
    detector?: string;
    file?: string;
    lines?: string;
    snippet?: string;
    note: string;
  };
  verifierAgentId: string;
}

export interface VerificationReport {
  sourceName: string;
  sourceHash: string;
  engine: {
    method: 'static-analysis' | 'ast-rule';
    name: string;
    version?: string;
    fallbackReason?: string;
  };
  verifications: FindingVerification[];
  summary: {
    confirmed: number;
    rejected: number;
    partial: number;
    inconclusive: number;
    missed: number;
  };
}

export interface CommanderPhase {
  name: string;
  taskType: ServiceTaskType;
  goal: string;
}

export interface CommanderPhaseResult {
  index: number;
  phase: CommanderPhase;
  success: boolean;
  content: string;
  error?: string;
}

export interface CommanderBudget {
  maxTotal: Money;
  maxPerPhase: Money;
  maxPhases: number;
  spent: Money;
  phaseCount: number;
}

/**
 * Matches HunterRunResult from agents/hunter/src/react-engine.ts
 * This is the payload of the SSE `done` event.
 */
export interface HunterRunResult {
  missionId: string;
  goal: string;
  mode: 'scripted' | 'react' | 'commander';
  service: {
    id: string;
    name: string;
    description?: string;
    endpoint: string;
    price: string;
    currency?: string;
    asset?: AssetRef;
    agentId?: string;
    paymentRails?: string[];
    network?: string;
    provider?: string;
    taskType?: string;
    skills?: string[];
    reputation?: {
      score: number;
      count: number;
      trend: 'up' | 'down' | 'stable';
      recentScores: number[];
      lastUsedAt: number;
      qualified: boolean;
    };
  };
  quote: Record<string, unknown>;
  paymentTx: string;
  execution: ExecutionResult;
  receiptVerified: boolean;
  evaluation: {
    score: number;
    summary: string;
  };
  reflection?: {
    missionId: string;
    goal: string;
    serviceUsed: string;
    taskType: string;
    score: number;
    lesson: string;
    timestamp: number;
  };
  verification?: {
    service: HunterRunResult['service'];
    quote: Record<string, unknown>;
    paymentTx: string;
    execution: ExecutionResult;
    receiptVerified: boolean;
    report: VerificationReport;
  };
  finalMessage: string;
  phases?: CommanderPhaseResult[];
  budget?: CommanderBudget;
}

export type PaymentStatus =
  | 'payment-required'
  | 'payment-submitted'
  | 'payment-completed'
  | 'payment-rejected'
  | 'payment-failed';
