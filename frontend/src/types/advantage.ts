import type { Money, VerificationReport } from '@/types/agent';

export interface MeasuredAuditMetrics {
  kind: 'contract-audit';
  status: 'measured';
  missionId: string;
  missionSource: 'live-run' | 'recovered-evidence';
  durationMs: number;
  cost?: Money;
  auditorFindings: number;
  auditorCriticalHighFindings: number;
  signedReceipts: number;
  confirmedTransactions: string[];
  hunterEvaluationScore: number;
  quality?: {
    benchmarkId: string;
    groundTruthSourceHash: string;
    groundTruthFindings: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    evidenceCompleteness: number;
    matchedGroundTruthIds: string[];
    missedGroundTruthIds: string[];
  };
  verifier?: {
    engine: VerificationReport['engine'];
    summary: VerificationReport['summary'];
    checks: number;
  };
}

export interface MeasuredTokenRiskMetrics {
  kind: 'token-risk';
  status: 'measured';
  missionId: string;
  missionSource: 'live-run' | 'recovered-evidence';
  durationMs: number;
  cost?: Money;
  signedReceipts: number;
  confirmedTransactions: string[];
  hunterEvaluationScore: number;
  target: {
    address: string;
    classification: 'eoa' | 'contract' | 'erc20';
    blockNumber: number;
    observedAt: string;
    token?: { symbol?: string; decimals?: number };
  };
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskSignals: number;
  highCriticalSignals: number;
  coverage: { measured: number; total: number };
  securityReview?: {
    source: 'paid-mission' | 'post-run-evidence';
    paid: boolean;
    serviceId: string;
    durationMs?: number;
    engine: {
      method: 'independent-rpc-replay';
      name: 'agora-token-risk-verifier';
      version: '1';
      endpoint: string;
      independentTransport: boolean;
    };
    summary: {
      confirmed: number;
      mismatched: number;
      unavailable: number;
      total: number;
    };
    conclusion: {
      status: 'confirmed' | 'partial' | 'rejected';
      originalRiskScore: number;
      replayedRiskScore: number;
      originalRiskLevel: 'low' | 'medium' | 'high' | 'critical';
      replayedRiskLevel: 'low' | 'medium' | 'high' | 'critical';
    };
  };
  enrichment?: {
    source: 'post-run-evidence';
    paid: false;
    durationMs: number;
    observedAt: string;
    coverage: {
      originalMeasured: number;
      postRunMeasured: number;
      total: number;
      added: string[];
      partial: string[];
      unavailable: string[];
    };
    liquidity: {
      venue: 'PancakeSwap';
      pair: string;
      pairExists: boolean;
      reserveTokenRaw?: string;
      reserveWrappedNativeRaw?: string;
      tokenReservePartsPerBillionOfSupply?: string;
      discoveredV3Pools: number;
      activeV3Pools: number;
      interpretation: string;
    };
    quote: {
      status: 'quote-only' | 'unavailable';
      inputTokenRaw: string;
      outputWrappedNativeRaw?: string;
      path: [string, string];
      limitation: string;
    };
    recentTransactions:
      | { status: 'unavailable'; reason: string }
      | {
          status: 'measured';
          observedTransfers: number;
          blockRange: { from: number; to: number };
          activity: {
            transfers: number;
            uniqueTransactions: number;
            mints: number;
            burns: number;
            uniqueSenders: number;
            uniqueRecipients: number;
            transferredRaw: string;
            firstBlock?: number;
            lastBlock?: number;
          };
        };
    holderConcentration:
      | { status: 'unavailable'; reason: string }
      | {
          status: 'measured';
          evidenceFile: string;
          snapshotBlock: number;
          holderCount: number;
          totalSupplyRaw: string;
          top1PartsPerMillion: number;
          top5PartsPerMillion: number;
          top10PartsPerMillion: number;
          validation: {
            complete: true;
            method: string;
            blockBalanceSumRaw: string;
            totalSupplyRaw: string;
            balanceReadFailures: 0;
            missingSupplyRaw: '0';
          };
        };
    sellabilityExecution?: {
      status: 'confirmed';
      evidenceFile: string;
      observedAt: string;
      blockNumber: number;
      venue: 'PancakeSwap V2';
      inputAmountRaw: string;
      outputAmountRaw: string;
      slippageBps: number;
      minimumOutRaw: string;
      approvalTransaction: string;
      swapTransaction: string;
      routerAllowanceAfterSwapRaw: '0';
    };
    limitations: string[];
  };
  limitations: string[];
}

export interface PartialDueDiligenceMetrics {
  kind: 'due-diligence';
  status: 'partial';
  synthesisKind: 'same-target-candidate';
  durationMs: number;
  noNewPayment: true;
  reusedPaidInvestigation: {
    missionId: string;
    transactionHash: string;
    amount: string;
    currency: string;
  };
  target: {
    chainId: number;
    proxy: string;
    implementation: string;
    sourceName: string;
    sourceHash: string;
    sourceMode: 'verified-source';
    reportBlock: number;
  };
  bindings: Record<string, true>;
  auditor: {
    status: 'measured' | 'measured-partial' | 'unavailable';
    findings: number;
    provider: string;
    model: string;
    durationMs: number;
    failureReason?: string;
  };
  verifier: {
    engine: VerificationReport['engine'];
    summary: VerificationReport['summary'];
    uncoveredDetections: number;
  };
  onchain: {
    riskScore: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    reviewStatus: 'confirmed' | 'partial' | 'rejected';
  };
  market?: {
    coverage: { originalMeasured: number; postRunMeasured: number; total: number; added: string[]; partial: string[]; unavailable: string[] };
    liquidity: { venue: 'PancakeSwap'; pair: string; pairExists: boolean; reserveTokenRaw?: string; reserveWrappedNativeRaw?: string; activeV3Pools: number };
    quoteStatus: 'quote-only' | 'unavailable';
    recentTransactionsStatus: 'measured' | 'unavailable';
    holderConcentrationStatus: 'unavailable' | 'measured';
    sellabilityStatus?: 'partial' | 'measured';
  };
  decision: {
    status: 'avoid' | 'high-caution' | 'caution' | 'no-high-risk-established';
    reasons: string[];
    requiredActions: string[];
  };
  limitations: string[];
}

export interface MeasuredDueDiligenceMetrics {
  kind: 'due-diligence';
  status: 'measured';
  synthesisKind: 'paid-two-phase-reconciled';
  missionIds: [string, string];
  durationMs: number;
  cost: Money;
  target: { chainId: number; address: string; blockNumber: number };
  payments: Array<{
    serviceId: 'auditor-v1' | 'verifier-v1' | 'investigator-v1' | 'risk-verifier-v1';
    amountRaw: string;
    transaction: string;
  }>;
  audit: {
    findings: number;
    criticalHighFindings: number;
    verifierSummary: VerificationReport['summary'];
    hunterEvaluationScore: number;
  };
  onchain: {
    riskScore: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskSignals: number;
    verifierSummary: { confirmed: number; mismatched: number; unavailable: number; total: number };
    verifierStatus: 'confirmed' | 'partial' | 'rejected';
  };
  reconciliation: {
    orphanedAuditorSettlementRaw: string;
    orphanedAuditorSettlementTx: string;
    refundRaw: string;
    refundTx: string;
    grossProviderTransfersRaw: string;
    netProviderSpendRaw: string;
    intendedNetSpendRaw: string;
    balanced: true;
  };
  authorityCleanup: {
    originalAuthorityRevoked: true;
    supplementAuthorityRevoked: true;
    finalPermit2AllowanceRaw: '0';
    allSessionMaterialDeleted: true;
    postRevokeNegativeTestsRejected: true;
  };
  decision: {
    status: 'avoid' | 'high-caution' | 'caution' | 'no-high-risk-established';
    reasons: string[];
  };
  limitations: string[];
}

interface ModelOnlyCandidateCommon {
  status: 'model-only-candidate';
  experimentId: 'contract-audit' | 'token-risk' | 'full-due-diligence';
  model: { provider: string; model: string };
  durationMs: number;
  totalTokens: number;
  controlledBaseline: false;
  independentHuman: false;
  costUsd: null;
  limitations: string[];
}

export type ModelOnlyBaselineCandidate =
  | (ModelOnlyCandidateCommon & {
      kind: 'contract-audit';
      outcome: {
        findings: number;
        truePositives: number;
        falsePositives: number;
        falseNegatives: number;
        severityAccuracy: number;
      };
    })
  | (ModelOnlyCandidateCommon & {
      kind: 'token-risk';
      outcome: {
        rpcDurationMs: number;
        modelDurationMs: number;
        riskSignals: number;
        recommendation: string;
      };
    })
  | (ModelOnlyCandidateCommon & {
      kind: 'due-diligence';
      outcome: {
        slitherDurationMs: number;
        rawSlitherDetections: number;
        trustDecision: string;
        postFreezeCorrections: number;
      };
    });

export interface AdvantageExperiment {
  id: 'contract-audit' | 'token-risk' | 'due-diligence';
  name: string;
  task: string;
  agentWorkflow: string[];
  status: 'completed' | 'partial' | 'pending';
  agent: MeasuredAuditMetrics | MeasuredTokenRiskMetrics | MeasuredDueDiligenceMetrics | PartialDueDiligenceMetrics | { status: 'pending'; reason: string };
  baseline:
    | { status: 'pending'; reason: string }
    | {
        status: 'measured';
        workflow: 'without-marketplace-agent';
        reviewerType: 'automated-operator' | 'independent-ai';
        independentHuman: false;
        blindToAgentOutputs: boolean;
        model: { provider: string; model: string };
        durationMs: number;
        totalTokens: number;
        costUsd: number;
        costBasis: string;
        qualityScore: number;
        qualityScale: 100;
        qualitySummary: string;
        artifact: string;
        artifactHash: string;
      };
  comparison?: {
    status: 'completed';
    qualityDelta: number;
    durationDeltaMs: number;
    result: string;
    costCaveat: string;
    agentQualityScore: number;
    baselineQualityScore: number;
  };
  modelCandidate?: ModelOnlyBaselineCandidate;
  toolReference?: {
    status: 'measured';
    kind: 'tool-only-static-analysis';
    tool: string;
    version: string;
    durationMs: number;
    cost: { currency: string; amount: number; basis: string };
    detections: number;
    quality: NonNullable<MeasuredAuditMetrics['quality']>;
    controlledHumanBaselineStatus: 'pending';
    limitations: string[];
  };
  groundTruth:
    | { status: 'pending'; reason: string }
    | {
        status: 'reviewed';
        benchmarkId: string;
        sourceHash: string;
        findings: number;
        reviewerType?: 'deterministic-operator' | 'independent-ai';
        independentHuman?: false;
        artifact?: string;
        reviewMethod: string[];
      };
}

export interface AdvantageReport {
  generatedAt: number;
  summary: {
    experiments: number;
    measuredAgentRuns: number;
    measuredToolReferences: number;
    measuredIndependentReviews: number;
    measuredEnrichments: number;
    measuredModelCandidates: number;
    completedComparisons: number;
  };
  methodology: {
    duration: string;
    cost: string;
    quality: string;
  };
  experiments: AdvantageExperiment[];
}
