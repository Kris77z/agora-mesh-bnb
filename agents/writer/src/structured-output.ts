import { z } from "zod";
import type { OnchainRiskReport, TokenRiskVerificationReport } from "@rebel/shared";

const auditReportSchema = z.object({
  vulnerabilities: z.array(
    z.object({
      findingId: z.string().min(1),
      title: z.string().min(1),
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      description: z.string().min(1),
      evidence: z.object({
        file: z.string().optional(),
        lines: z.string().optional(),
        snippet: z.string().optional(),
        bytecodeOffset: z.string().optional()
      }),
      exploitScenario: z.string().min(1),
      recommendation: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  )
});

const onchainRiskReportSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  target: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    classification: z.enum(["eoa", "contract", "erc20"]),
    bytecodeSize: z.number().int().nonnegative(),
    bytecodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()
  }),
  observedAt: z.string().datetime(),
  blockNumber: z.number().int().nonnegative(),
  sources: z.array(z.object({
    kind: z.literal("rpc"),
    endpoint: z.string().min(1),
    methods: z.array(z.string().min(1)),
    observedAt: z.string().datetime()
  })).min(1),
  facts: z.object({
    nativeBalanceWei: z.string().regex(/^\d+$/),
    transactionCount: z.string().regex(/^\d+$/),
    token: z.object({
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().int().min(0).max(255).optional(),
      totalSupply: z.string().regex(/^\d+$/).optional()
    }).optional(),
    ownership: z.object({
      owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      probe: z.enum(["owner()", "getOwner()", "unavailable"]),
      renounced: z.boolean().optional()
    }),
    proxy: z.object({
      standard: z.literal("eip-1967"),
      implementation: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      admin: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      implementationBytecodeSize: z.number().int().nonnegative().optional(),
      implementationBytecodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()
    })
  }),
  riskSignals: z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    title: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.number().min(0).max(1)
  })),
  riskScore: z.number().int().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  coverage: z.object({
    accountState: z.literal("measured"),
    contractBytecode: z.literal("measured"),
    tokenMetadata: z.enum(["measured", "not-applicable", "partial"]),
    ownership: z.enum(["measured", "unavailable"]),
    proxySlots: z.literal("measured"),
    holderConcentration: z.literal("not-measured"),
    liquidity: z.literal("not-measured"),
    recentTransactions: z.literal("not-measured")
  }),
  limitations: z.array(z.string().min(1)),
  recommendation: z.string().min(1)
});

const tokenRiskVerificationReportSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  sourceReportHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceObservedAt: z.string().datetime(),
  verifiedAt: z.string().datetime(),
  blockNumber: z.number().int().nonnegative(),
  engine: z.object({
    method: z.literal("independent-rpc-replay"),
    name: z.literal("agora-token-risk-verifier"),
    version: z.literal("1"),
    endpoint: z.string().min(1),
    independentTransport: z.boolean()
  }),
  checks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["confirmed", "mismatch", "unavailable"]),
    expected: z.string(),
    actual: z.string(),
    evidence: z.string().min(1)
  })).min(1),
  summary: z.object({
    confirmed: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    total: z.number().int().positive()
  }),
  conclusion: z.object({
    status: z.enum(["confirmed", "partial", "rejected"]),
    originalRiskScore: z.number().int().min(0).max(100),
    replayedRiskScore: z.number().int().min(0).max(100),
    originalRiskLevel: z.enum(["low", "medium", "high", "critical"]),
    replayedRiskLevel: z.enum(["low", "medium", "high", "critical"])
  }),
  limitations: z.array(z.string().min(1))
});

const schemas: Record<string, z.ZodType> = {
  "audit-vulnerabilities-v1": auditReportSchema,
  "onchain-risk-report-v1": onchainRiskReportSchema,
  "token-risk-verification-v1": tokenRiskVerificationReportSchema
};

export function parseOnchainRiskReport(value: unknown): OnchainRiskReport {
  return onchainRiskReportSchema.parse(value) as OnchainRiskReport;
}

export function parseTokenRiskVerificationReport(value: unknown): TokenRiskVerificationReport {
  return tokenRiskVerificationReportSchema.parse(value) as TokenRiskVerificationReport;
}

export function validateStructuredSkillOutput(schemaName: string | undefined, value: unknown): unknown {
  if (!schemaName) {
    return value;
  }
  const schema = schemas[schemaName];
  return schema ? schema.parse(value) : value;
}
