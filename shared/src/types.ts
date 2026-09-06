export type LanguageCode = "zh-CN" | "en-US";

export const DEFAULT_LANGUAGE_CODE: LanguageCode = "en-US";

export type HexAddress = `0x${string}`;
export type HexHash = `0x${string}`;

export interface AssetRef {
  chainId: number;
  kind: "native" | "erc20";
  address?: HexAddress;
  symbol: string;
  decimals: number;
}

export interface Money {
  asset: AssetRef;
  /** Token amount in the asset's smallest unit. */
  amount: string;
}

export type PaymentRail = "legacy-native" | "x402" | "erc8183";

export interface PaymentContext {
  requestHash: string;
  taskType: string;
  timestamp: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

export interface NativeTransferAccept {
  scheme: "native-transfer";
  network: string;
  amount: string;
  asset: "native";
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface PaymentRequiredResponse {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
  };
  accepts: NativeTransferAccept[];
  paymentContext: PaymentContext;
}

export interface ExecuteRequest {
  taskType?: string;
  taskInput?: string;
  timestamp?: number;
  paymentTx?: string;
  locale?: LanguageCode;
}

export interface HunterRunRequest {
  goal?: string;
  mode?: HunterRunRequestMode;
  locale?: LanguageCode;
}

export interface Receipt {
  signatureScheme?: "agora-request-result-v2";
  requestHash: string;
  resultHash: string;
  provider: string;
  timestamp: number;
  signature: string;
}

export interface PaymentCompleted {
  status: "payment-completed";
  transaction: string;
  network: string;
}

export interface ExecuteSuccessResponse {
  result: string;
  receipt: Receipt;
  payment: PaymentCompleted;
}

export type ServiceReputationTrend = "up" | "down" | "stable";

export interface ServiceReputation {
  score: number;
  count: number;
  trend: ServiceReputationTrend;
  recentScores: number[];
  lastUsedAt: number;
  qualified: boolean;
}

export interface ServiceInfo {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  taskType?: string;
  skills?: string[];
  reputation?: ServiceReputation;
  /** Legacy raw amount retained while service callers migrate to Money. */
  price: string;
  currency: string;
  asset?: AssetRef;
  agentId?: string;
  paymentRails?: PaymentRail[];
  averageLatencyMs?: number;
  offerVersion?: string;
  network: string;
  provider: string;
  availability?: {
    available: boolean;
    reason?: string;
  };
}

export interface ServiceRegistry {
  services: ServiceInfo[];
}

export interface AgentCapability {
  type: "mcp" | "a2a" | "oasf";
  endpoint?: string;
  skills?: string[];
  tools?: string[];
}

export interface AgentIdentity {
  agentId: string;
  name: string;
  description: string;
  image?: string;
  walletAddress: string;
  capabilities: AgentCapability[];
  trustModels: string[];
  active: boolean;
  registeredAt: number;
}

export interface AgentFeedback {
  agentId: string;
  reviewer: string;
  value: number;
  tags: string[];
  text?: string;
  timestamp: number;
}

export type HunterRunRequestMode = "single" | "commander";

export type HunterServiceTaskType =
  | "content-generation"
  | "smart-contract-audit"
  | "finding-verification"
  | "token-risk-verification"
  | "onchain-investigation"
  | "defi-analysis"
  | "gas-optimization"
  | "token-scan"
  | "tx-decode"
  | "abi-interact"
  | "yield-search";

export interface CommanderPhase {
  name: string;
  taskType: HunterServiceTaskType;
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

export type AuthorityStatus = "active" | "expired" | "revoked" | "invalid";

export interface AuthorityRecord {
  authorityId: string;
  walletAddress: HexAddress;
  sessionPublicKey: HexAddress;
  chainId: number;
  allowedCalls: { to: HexAddress; selectors?: HexAddress[] }[];
  spendLimits: { asset: AssetRef; limit: string; period: "total" | "day" }[];
  expiry: number;
  status: AuthorityStatus;
  grantTxHash?: HexHash;
  revokeTxHash?: HexHash;
  createdAt: number;
}

export type MissionStatus =
  | "created"
  | "planning"
  | "discovering"
  | "quoted"
  | "paying"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface Mission {
  missionId: string;
  goal: string;
  chainId: number;
  authorityId: string;
  budget: Money;
  spent: Money[];
  selectedOffers: string[];
  status: MissionStatus;
  createdAt: number;
  completedAt?: number;
}

export interface PaymentEvidence {
  paymentId: string;
  rail: PaymentRail;
  missionId: string;
  serviceId: string;
  resource: string;
  requestHash: HexHash;
  amount: Money;
  recipient: HexAddress;
  txHash?: HexHash;
  jobId?: string;
  status: "required" | "signed" | "submitted" | "confirmed" | "failed";
  createdAt: number;
}

export interface SecurityFinding {
  findingId: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  description: string;
  evidence: { file?: string; lines?: string; snippet?: string; bytecodeOffset?: string };
  exploitScenario: string;
  recommendation: string;
  confidence: number;
}

export type SecurityInputMode = "inline-source" | "verified-source";

/** Canonical security-task payload passed from Hunter to Auditor. */
export interface SecurityTaskInput {
  chainId: number;
  mode: SecurityInputMode;
  sourceName: string;
  source: string;
  /** Original compiler source units when verified multi-file metadata is available. */
  sources?: Record<string, string>;
  /** Explorer compiler remappings, preserved for compiler-backed verification. */
  remappings?: string[];
  sourceHash: string;
  contractAddress?: HexAddress;
  explorerUrl?: string;
}

export interface AuditReport {
  vulnerabilities: SecurityFinding[];
}

export type OnchainRiskLevel = "low" | "medium" | "high" | "critical";

export interface OnchainRiskSignal {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  evidence: string;
  confidence: number;
}

export interface OnchainRiskReport {
  version: 1;
  chainId: number;
  target: {
    address: HexAddress;
    classification: "eoa" | "contract" | "erc20";
    bytecodeSize: number;
    bytecodeHash?: HexHash;
  };
  observedAt: string;
  blockNumber: number;
  sources: Array<{
    kind: "rpc";
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
      owner?: HexAddress;
      probe: "owner()" | "getOwner()" | "unavailable";
      renounced?: boolean;
    };
    proxy: {
      standard: "eip-1967";
      implementation?: HexAddress;
      admin?: HexAddress;
      implementationBytecodeSize?: number;
      implementationBytecodeHash?: HexHash;
    };
  };
  riskSignals: OnchainRiskSignal[];
  riskScore: number;
  riskLevel: OnchainRiskLevel;
  coverage: {
    accountState: "measured";
    contractBytecode: "measured";
    tokenMetadata: "measured" | "not-applicable" | "partial";
    ownership: "measured" | "unavailable";
    proxySlots: "measured";
    holderConcentration: "not-measured";
    liquidity: "not-measured";
    recentTransactions: "not-measured";
  };
  limitations: string[];
  recommendation: string;
}

export interface TokenRiskVerificationCheck {
  id: string;
  status: "confirmed" | "mismatch" | "unavailable";
  expected: string;
  actual: string;
  evidence: string;
}

/** Independent, block-bound replay of an OnchainRiskReport. */
export interface TokenRiskVerificationReport {
  version: 1;
  chainId: number;
  target: HexAddress;
  sourceReportHash: string;
  sourceObservedAt: string;
  verifiedAt: string;
  blockNumber: number;
  engine: {
    method: "independent-rpc-replay";
    name: "agora-token-risk-verifier";
    version: "1";
    endpoint: string;
    independentTransport: boolean;
  };
  checks: TokenRiskVerificationCheck[];
  summary: {
    confirmed: number;
    mismatched: number;
    unavailable: number;
    total: number;
  };
  conclusion: {
    status: "confirmed" | "partial" | "rejected";
    originalRiskScore: number;
    replayedRiskScore: number;
    originalRiskLevel: OnchainRiskLevel;
    replayedRiskLevel: OnchainRiskLevel;
  };
  limitations: string[];
}

export type VerificationMethod = "static-analysis" | "ast-rule" | "llm-assisted";

export interface FindingVerification {
  findingId: string;
  status: "confirmed" | "rejected" | "partial" | "inconclusive" | "missed";
  method: VerificationMethod;
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
    method: "static-analysis" | "ast-rule";
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

export type HunterTraceEventType =
  | "run_started"
  | "mission_decomposed"
  | "phase_started"
  | "phase_completed"
  | "services_discovered"
  | "service_ranked"
  | "security_input_resolved"
  | "service_selected"
  | "quote_received"
  | "x402_requirement_received"
  | "payment_policy_checked"
  | "payment_confirmed"
  | "payment_state"
  | "execution_started"
  | "execution_heartbeat"
  | "tool_call"
  | "tool_result"
  | "receipt_verified"
  | "verifier_hired"
  | "finding_verified"
  | "risk_verifier_hired"
  | "risk_fact_verified"
  | "evaluation_completed"
  | "feedback_submitted"
  | "llm_response"
  | "run_completed"
  | "run_failed";

export interface HunterTraceEvent {
  type: HunterTraceEventType;
  at: string;
  data?: unknown;
}
