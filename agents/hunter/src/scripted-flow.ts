import { randomUUID } from "node:crypto";
import {
  localizeByLocale,
  DEFAULT_LANGUAGE_CODE,
  rankServiceOffers,
  sameAsset,
} from "@rebel/shared";
import type {
  AuditReport,
  ExecuteSuccessResponse,
  HunterServiceTaskType,
  Money,
  NativeTransferAccept,
  OnchainRiskReport,
  PaymentRequiredResponse,
  ServiceInfo,
  X402ExecuteSuccessResponse,
  X402PaymentRequirement,
  SecurityTaskInput,
  RankedServiceOffer
} from "@rebel/shared";
import { hunterConfig } from "./config.js";
import { HunterError } from "./errors.js";
import { checkBalanceTool, makePaymentTool } from "./tools/payment.js";
import {
  requestServiceQuoteWithFallback,
  submitPaymentAndGetResult
} from "./tools/service.js";
import { evaluateResultTool, verifyReceiptTool } from "./tools/verify.js";
import { discoverServices } from "./tools/discover.js";
import { getServiceReputationMap } from "./tools/reputation.js";
import { submitAutoFeedback } from "./feedback-autopilot.js";
import { emitTrace, type HunterRunOptions } from "./trace-emitter.js";
import type { SingleHunterRunResult } from "./run-types.js";
import { reflectAndStoreExperience } from "./tools/reflect.js";
import { hunterLog, hunterWarn, hunterError, hunterDebug } from "./logger.js";
import { runProductionX402Purchase } from "./integrations/altana/x402-client.js";
import { resolveSecurityTaskInput } from "./security-input.js";
import {
  independentRiskVerifierCandidates,
  independentVerifierCandidates,
  parseAuditReport,
  parseOnchainRiskReport,
  parseTokenRiskVerificationReport,
  parseVerificationReport
} from "./security-pipeline.js";

const TASK_TYPE_PATTERNS: Array<{ taskType: HunterServiceTaskType; patterns: RegExp[] }> = [
  {
    taskType: "onchain-investigation",
    patterns: [
      /onchain investigat/i,
      /token risk/i,
      /contract risk/i,
      /wallet (?:risk|behavio(?:u)?r)/i,
      /holder concentration/i,
      /honeypot/i,
      /rug.?pull/i,
      /链上调查/,
      /代币风险/,
      /持仓集中度/,
      /钱包行为/
    ]
  },
  {
    taskType: "smart-contract-audit",
    patterns: [
      /audit/i,
      /security/i,
      /vulnerability/i,
      /solidity/i,
      /\b(?:abstract\s+)?(?:contract|interface|library)\s+[A-Za-z_]/i,
      /0x[a-fA-F0-9]{40}/,
      /reentrancy/i,
      /审计/,
      /漏洞/
    ]
  },
  {
    taskType: "defi-analysis",
    patterns: [/defi/i, /tvl/i, /yield/i, /protocol/i, /liquidity/i, /收益/, /流动性/, /借贷/]
  },
  {
    taskType: "content-generation",
    patterns: [/write/i, /content/i, /article/i, /tweet/i, /analysis/i, /文案/, /写作/, /总结/]
  }
];

export function inferTaskTypeFromGoal(goal: string): HunterServiceTaskType | undefined {
  for (const item of TASK_TYPE_PATTERNS) {
    if (item.patterns.some((pattern) => pattern.test(goal))) {
      return item.taskType;
    }
  }
  return undefined;
}

export function filterServicesByTaskType(services: ServiceInfo[], taskType?: string): ServiceInfo[] {
  if (!taskType) {
    return services;
  }
  const matched = services.filter((item) => !item.taskType || item.taskType === taskType);
  if (
    taskType === "smart-contract-audit" ||
    taskType === "finding-verification" ||
    taskType === "token-risk-verification" ||
    taskType === "onchain-investigation"
  ) {
    return matched.filter((item) => item.taskType === taskType);
  }
  return matched.length > 0 ? matched : services;
}

export function chooseCheapestService(services: ServiceInfo[]): ServiceInfo {
  const sorted = [...services].sort((a, b) => {
    const priceA = BigInt(a.price);
    const priceB = BigInt(b.price);
    if (priceA === priceB) {
      return 0;
    }
    return priceA < priceB ? -1 : 1;
  });
  const selected = sorted[0];
  if (!selected) {
    throw new HunterError(404, "NO_SERVICE_AVAILABLE", "No service found in registry");
  }
  return selected;
}

export async function chooseBestService(services: ServiceInfo[]): Promise<ServiceInfo> {
  return (await getRankedServiceOffers(services))[0]?.service ?? chooseCheapestService(services);
}

export async function getRankedServiceOffers(
  services: ServiceInfo[],
  taskType?: string
): Promise<RankedServiceOffer[]> {
  const reputationMap = await getServiceReputationMap(services);
  return rankServiceOffers(services, {
    taskType,
    reputationScores: reputationMap
  });
}

export async function rankServicesByPreference(services: ServiceInfo[]): Promise<ServiceInfo[]> {
  return (await getRankedServiceOffers(services)).map((entry) => entry.service);
}

/** Build a human-readable reason for selecting a specific service */
async function buildSelectionReason(
  selected: ServiceInfo,
  candidates: ServiceInfo[],
): Promise<{ reason: string; reputationPct: number; priceRank: number; totalCandidates: number }> {
  const ranking = await getRankedServiceOffers(candidates, selected.taskType);
  const rankedEntry = ranking.find((entry) => entry.service.id === selected.id);
  const reputationPct = Math.round((rankedEntry?.scores.reputation ?? 0) * 100);
  const sorted = [...candidates].sort((a, b) => {
    const pa = BigInt(a.price);
    const pb = BigInt(b.price);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const priceRank = sorted.findIndex((s) => s.id === selected.id) + 1;
  const totalCandidates = candidates.length;

  return {
    reason: rankedEntry?.reason ?? "Selected by default",
    reputationPct,
    priceRank,
    totalCandidates,
  };
}

export function pickNativeTransferAccept(quote: PaymentRequiredResponse): NativeTransferAccept {
  const accept = quote.accepts.find((item) => item.scheme === "native-transfer");
  if (!accept) {
    throw new HunterError(422, "UNSUPPORTED_PAYMENT_SCHEME", "No native-transfer quote found");
  }
  return accept;
}

export interface ExecutePhaseOptions {
  preferredTaskType?: HunterServiceTaskType;
  missionId?: string;
  emitLifecycleEvents?: boolean;
  maxSpend?: Money;
}

export function createPhaseSpendApprover(
  maxSpend?: Money
): (service: ServiceInfo, amount: string) => void {
  let approved = 0n;
  return (service, amount) => {
    if (!maxSpend) {
      return;
    }
    if (!/^\d+$/.test(amount)) {
      throw new HunterError(422, "PAYMENT_AMOUNT_INVALID", "Service quote amount must be an integer");
    }
    const asset = service.asset ?? hunterConfig.chain.nativeAsset;
    if (!sameAsset(asset, maxSpend.asset)) {
      throw new HunterError(
        422,
        "COMMANDER_BUDGET_ASSET_MISMATCH",
        "Service quote asset does not match the active phase budget"
      );
    }
    const nextApproved = approved + BigInt(amount);
    if (nextApproved > BigInt(maxSpend.amount)) {
      throw new HunterError(
        403,
        "COMMANDER_PHASE_BUDGET_EXCEEDED",
        "Primary and independent-review quotes exceed the remaining phase budget",
        {
          maxSpend: maxSpend.amount,
          alreadyApproved: approved.toString(),
          requested: amount
        }
      );
    }
    approved = nextApproved;
  };
}

export async function hireIndependentVerifier(input: {
  services: ServiceInfo[];
  auditor: ServiceInfo;
  securityInput: SecurityTaskInput;
  auditReport: AuditReport;
  missionId: string;
  locale: typeof DEFAULT_LANGUAGE_CODE;
  options: HunterRunOptions;
  approveSpend: (service: ServiceInfo, amount: string) => void;
}): Promise<NonNullable<SingleHunterRunResult["verification"]>> {
  const candidates = independentVerifierCandidates(input.services, input.auditor);
  if (candidates.length === 0) {
    throw new HunterError(
      503,
      "VERIFIER_UNAVAILABLE",
      "No independent finding-verification service is available"
    );
  }
  const ranked = await rankServicesByPreference(candidates);
  let service = ranked[0] ?? (await chooseBestService(candidates));
  const taskType = "finding-verification";
  const taskInput = JSON.stringify({
    source: input.securityInput.source,
    sourceName: input.securityInput.sourceName,
    sources: input.securityInput.sources,
    remappings: input.securityInput.remappings,
    findings: input.auditReport.vulnerabilities
  });
  emitTrace(input.options, "verifier_hired", {
    serviceId: service.id,
    agentId: service.agentId,
    provider: service.provider,
    auditorServiceId: input.auditor.id,
    findingCount: input.auditReport.vulnerabilities.length,
    sourceHash: input.securityInput.sourceHash
  });

  let quote: PaymentRequiredResponse | X402PaymentRequirement;
  let paymentTx: string;
  let execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
  const useX402 = hunterConfig.x402.enabled && service.paymentRails?.includes("x402");
  if (useX402) {
    const purchase = await runProductionX402Purchase({
      missionId: input.missionId,
      service,
      taskType,
      taskInput,
      locale: input.locale,
      onRequirement: ({ requirement, selectedAccept, request }) => {
        input.approveSpend(service, selectedAccept.amount);
        emitTrace(input.options, "x402_requirement_received", {
          role: "verifier",
          requestHash: request.requestHash,
          resource: requirement.resource.url,
          accepts: requirement.accepts.length
        });
        emitTrace(input.options, "payment_policy_checked", {
          role: "verifier",
          approved: true,
          requestHash: request.requestHash,
          amount: selectedAccept.amount,
          asset: selectedAccept.asset,
          payTo: selectedAccept.payTo,
          network: selectedAccept.network,
          transferMethod: selectedAccept.extra.assetTransferMethod
        });
        emitTrace(input.options, "execution_started", {
          role: "verifier",
          serviceId: service.id,
          taskType,
          sourceHash: input.securityInput.sourceHash
        });
      }
    });
    quote = purchase.requirement;
    execution = purchase.execution;
    paymentTx = purchase.execution.payment.transaction;
    emitTrace(input.options, "payment_confirmed", {
      role: "verifier",
      requestHash: purchase.request.requestHash,
      txHash: paymentTx,
      amount: purchase.execution.payment.amount,
      recipient: purchase.execution.payment.recipient,
      network: purchase.execution.payment.network,
      cached: purchase.execution.cached
    });
  } else {
    const quoteRequest = await requestServiceQuoteWithFallback({
      services: ranked,
      taskType,
      taskInput,
      locale: input.locale
    });
    service = quoteRequest.service;
    quote = quoteRequest.quote;
    const accept = pickNativeTransferAccept(quote);
    input.approveSpend(service, accept.amount);
    emitTrace(input.options, "quote_received", {
      role: "verifier",
      requestHash: quote.paymentContext.requestHash,
      amount: accept.amount,
      payTo: accept.payTo,
      network: accept.network
    });
    await checkBalanceTool();
    const payment = await makePaymentTool(accept);
    paymentTx = payment.txHash;
    emitTrace(input.options, "payment_state", {
      role: "verifier",
      status: "payment-submitted",
      txHash: paymentTx
    });
    emitTrace(input.options, "execution_started", {
      role: "verifier",
      serviceId: service.id,
      taskType,
      sourceHash: input.securityInput.sourceHash
    });
    execution = await submitPaymentAndGetResult({
      service,
      paymentTx,
      taskType,
      taskInput,
      timestamp: quote.paymentContext.timestamp,
      locale: input.locale
    });
  }

  const receiptCheck = verifyReceiptTool(execution.receipt, {
    result: execution.result,
    provider: service.provider
  });
  emitTrace(input.options, "receipt_verified", {
    role: "verifier",
    isValid: receiptCheck.isValid,
    signatureValid: receiptCheck.signatureValid,
    resultHashMatches: receiptCheck.resultHashMatches,
    providerMatches: receiptCheck.providerMatches,
    provider: execution.receipt.provider,
    requestHash: execution.receipt.requestHash
  });
  if (!receiptCheck.isValid) {
    throw new HunterError(422, "VERIFIER_RECEIPT_INVALID", "Verifier receipt signature verification failed");
  }
  const report = parseVerificationReport(execution.result, input.securityInput.sourceHash, {
    findingIds: input.auditReport.vulnerabilities.map((finding) => finding.findingId),
    verifierAgentId: service.agentId
  });
  for (const verification of report.verifications) {
    emitTrace(input.options, "finding_verified", {
      ...verification,
      engine: report.engine,
      sourceHash: report.sourceHash
    });
  }
  return {
    service,
    quote,
    paymentTx,
    execution,
    receiptVerified: receiptCheck.isValid,
    report
  };
}

export async function hireIndependentRiskVerifier(input: {
  services: ServiceInfo[];
  investigator: ServiceInfo;
  sourceReport: OnchainRiskReport;
  missionId: string;
  locale: typeof DEFAULT_LANGUAGE_CODE;
  options: HunterRunOptions;
  approveSpend: (service: ServiceInfo, amount: string) => void;
}): Promise<NonNullable<SingleHunterRunResult["riskReview"]>> {
  const candidates = independentRiskVerifierCandidates(input.services, input.investigator);
  if (candidates.length === 0) {
    throw new HunterError(
      503,
      "TOKEN_RISK_VERIFIER_UNAVAILABLE",
      "No independent token-risk-verification service is available"
    );
  }
  const ranked = await rankServicesByPreference(candidates);
  let service = ranked[0] ?? (await chooseBestService(candidates));
  const taskType = "token-risk-verification";
  const taskInput = JSON.stringify({ report: input.sourceReport });
  emitTrace(input.options, "risk_verifier_hired", {
    serviceId: service.id,
    agentId: service.agentId,
    provider: service.provider,
    investigatorServiceId: input.investigator.id,
    target: input.sourceReport.target.address,
    blockNumber: input.sourceReport.blockNumber,
    riskSignals: input.sourceReport.riskSignals.length
  });

  let quote: PaymentRequiredResponse | X402PaymentRequirement;
  let paymentTx: string;
  let execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
  const useX402 = hunterConfig.x402.enabled && service.paymentRails?.includes("x402");
  if (useX402) {
    const purchase = await runProductionX402Purchase({
      missionId: input.missionId,
      service,
      taskType,
      taskInput,
      locale: input.locale,
      onRequirement: ({ requirement, selectedAccept, request }) => {
        input.approveSpend(service, selectedAccept.amount);
        emitTrace(input.options, "x402_requirement_received", {
          role: "risk-verifier",
          requestHash: request.requestHash,
          resource: requirement.resource.url,
          accepts: requirement.accepts.length
        });
        emitTrace(input.options, "payment_policy_checked", {
          role: "risk-verifier",
          approved: true,
          requestHash: request.requestHash,
          amount: selectedAccept.amount,
          asset: selectedAccept.asset,
          payTo: selectedAccept.payTo,
          network: selectedAccept.network,
          transferMethod: selectedAccept.extra.assetTransferMethod
        });
        emitTrace(input.options, "execution_started", {
          role: "risk-verifier",
          serviceId: service.id,
          taskType,
          target: input.sourceReport.target.address,
          blockNumber: input.sourceReport.blockNumber
        });
      }
    });
    quote = purchase.requirement;
    execution = purchase.execution;
    paymentTx = purchase.execution.payment.transaction;
    emitTrace(input.options, "payment_confirmed", {
      role: "risk-verifier",
      requestHash: purchase.request.requestHash,
      txHash: paymentTx,
      amount: purchase.execution.payment.amount,
      recipient: purchase.execution.payment.recipient,
      network: purchase.execution.payment.network,
      cached: purchase.execution.cached
    });
  } else {
    const quoteRequest = await requestServiceQuoteWithFallback({
      services: ranked,
      taskType,
      taskInput,
      locale: input.locale
    });
    service = quoteRequest.service;
    quote = quoteRequest.quote;
    const accept = pickNativeTransferAccept(quote);
    input.approveSpend(service, accept.amount);
    emitTrace(input.options, "quote_received", {
      role: "risk-verifier",
      requestHash: quote.paymentContext.requestHash,
      amount: accept.amount,
      payTo: accept.payTo,
      network: accept.network
    });
    await checkBalanceTool();
    const payment = await makePaymentTool(accept);
    paymentTx = payment.txHash;
    emitTrace(input.options, "payment_state", {
      role: "risk-verifier",
      status: "payment-submitted",
      txHash: paymentTx
    });
    emitTrace(input.options, "execution_started", {
      role: "risk-verifier",
      serviceId: service.id,
      taskType,
      target: input.sourceReport.target.address,
      blockNumber: input.sourceReport.blockNumber
    });
    execution = await submitPaymentAndGetResult({
      service,
      paymentTx,
      taskType,
      taskInput,
      timestamp: quote.paymentContext.timestamp,
      locale: input.locale
    });
  }

  const receiptCheck = verifyReceiptTool(execution.receipt, {
    result: execution.result,
    provider: service.provider
  });
  emitTrace(input.options, "receipt_verified", {
    role: "risk-verifier",
    isValid: receiptCheck.isValid,
    signatureValid: receiptCheck.signatureValid,
    resultHashMatches: receiptCheck.resultHashMatches,
    providerMatches: receiptCheck.providerMatches,
    provider: execution.receipt.provider,
    requestHash: execution.receipt.requestHash
  });
  if (!receiptCheck.isValid) {
    throw new HunterError(
      422,
      "TOKEN_RISK_VERIFIER_RECEIPT_INVALID",
      "Token Risk Verifier receipt signature verification failed"
    );
  }
  const report = parseTokenRiskVerificationReport(execution.result, input.sourceReport);
  for (const check of report.checks) {
    emitTrace(input.options, "risk_fact_verified", {
      ...check,
      target: report.target,
      blockNumber: report.blockNumber,
      sourceReportHash: report.sourceReportHash
    });
  }
  return {
    service,
    quote,
    paymentTx,
    execution,
    receiptVerified: receiptCheck.isValid,
    report
  };
}

export async function executePhase(
  goal: string,
  options: HunterRunOptions = {},
  executeOptions: ExecutePhaseOptions = {}
): Promise<SingleHunterRunResult> {
  const locale = options.locale ?? DEFAULT_LANGUAGE_CODE;
  const missionId = executeOptions.missionId ?? randomUUID();
  const emitLifecycleEvents = executeOptions.emitLifecycleEvents ?? true;
  const approveSpend = createPhaseSpendApprover(executeOptions.maxSpend);

  hunterLog(`--- executePhase start --- mission=${missionId}`);
  hunterLog(`goal: "${goal.slice(0, 120)}${goal.length > 120 ? '...' : ''}"`);
  if (executeOptions.preferredTaskType) {
    hunterLog(`preferredTaskType: ${executeOptions.preferredTaskType}`);
  }

  if (emitLifecycleEvents) {
    emitTrace(options, "run_started", {
      missionId,
      mode: "scripted",
      goal,
      preferredTaskType: executeOptions.preferredTaskType,
      locale
    });
  }

  const services = await discoverServices();
  hunterLog(`discover: found ${services.length} services [${services.map(s => s.id).join(', ')}]`);
  const inferredTaskType = inferTaskTypeFromGoal(goal);
  const taskTypeHint = executeOptions.preferredTaskType ?? inferredTaskType;
  const filteredServices = filterServicesByTaskType(services, taskTypeHint);
  if (filteredServices.length === 0) {
    throw new HunterError(
      404,
      "NO_SERVICE_AVAILABLE",
      `No service found for task type ${taskTypeHint ?? "unknown"}`
    );
  }
  emitTrace(options, "services_discovered", {
    count: services.length,
    serviceIds: services.map((service) => service.id),
    inferredTaskType,
    preferredTaskType: executeOptions.preferredTaskType,
    eligibleServiceIds: filteredServices.map((service) => service.id),
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      taskType: service.taskType,
      price: service.price,
      reputation: service.reputation
    }))
  });

  const ranking = await getRankedServiceOffers(filteredServices, taskTypeHint);
  const serviceCandidates = ranking.map((entry) => entry.service);
  const service = serviceCandidates[0] ?? (await chooseBestService(filteredServices));
  const taskType = service.taskType ?? taskTypeHint ?? "content-generation";
  emitTrace(options, "service_ranked", {
    taskType,
    weights: ranking[0]?.weights,
    candidates: ranking.map((entry) => ({
      rank: entry.rank,
      serviceId: entry.service.id,
      score: entry.score,
      scores: entry.scores,
      reason: entry.reason,
      price: entry.service.price,
      averageLatencyMs: entry.service.averageLatencyMs
    }))
  });
  const selectionInfo = await buildSelectionReason(service, filteredServices);
  emitTrace(options, "service_selected", {
    id: service.id,
    price: service.price,
    endpoint: service.endpoint,
    taskType,
    reason: selectionInfo.reason,
    reputationPct: selectionInfo.reputationPct,
    priceRank: selectionInfo.priceRank,
    totalCandidates: selectionInfo.totalCandidates,
  });
  hunterLog(`select: ${service.id} (${taskType}) price=${service.price} — ${selectionInfo.reason}`);

  let selectedService = service;
  let quote: PaymentRequiredResponse | X402PaymentRequirement;
  let paymentTx: string;
  let execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
  let resolvedTaskType = taskType;
  let securityInput: SecurityTaskInput | undefined;
  let serviceTaskInput = goal;
  if (taskType === "smart-contract-audit") {
    securityInput = await resolveSecurityTaskInput(goal);
    serviceTaskInput = JSON.stringify(securityInput);
    emitTrace(options, "security_input_resolved", {
      mode: securityInput.mode,
      chainId: securityInput.chainId,
      sourceName: securityInput.sourceName,
      sourceHash: securityInput.sourceHash,
      contractAddress: securityInput.contractAddress,
      explorerUrl: securityInput.explorerUrl
    });
  }
  const useX402 = hunterConfig.x402.enabled && service.paymentRails?.includes("x402");

  if (useX402) {
    hunterLog(`x402: requesting ${service.id} with an Altana scoped session...`);
    const executionStartedAt = Date.now();
    const executionHeartbeat = setInterval(() => {
      emitTrace(options, "execution_heartbeat", { elapsed: Date.now() - executionStartedAt });
    }, 10_000);
    try {
      const purchase = await runProductionX402Purchase({
        missionId,
        service,
        taskType,
        taskInput: serviceTaskInput,
        locale,
        onRequirement: ({ requirement, selectedAccept, request }) => {
          approveSpend(service, selectedAccept.amount);
          emitTrace(options, "x402_requirement_received", {
            requestHash: request.requestHash,
            resource: requirement.resource.url,
            accepts: requirement.accepts.length
          });
          emitTrace(options, "payment_policy_checked", {
            approved: true,
            requestHash: request.requestHash,
            amount: selectedAccept.amount,
            asset: selectedAccept.asset,
            payTo: selectedAccept.payTo,
            network: selectedAccept.network,
            transferMethod: selectedAccept.extra.assetTransferMethod
          });
          emitTrace(options, "execution_started", {
            serviceId: service.id,
            taskType,
            goal,
            rail: "x402"
          });
        }
      });
      quote = purchase.requirement;
      execution = purchase.execution;
      paymentTx = purchase.execution.payment.transaction;
      emitTrace(options, "payment_confirmed", {
        requestHash: purchase.request.requestHash,
        txHash: paymentTx,
        amount: purchase.execution.payment.amount,
        recipient: purchase.execution.payment.recipient,
        network: purchase.execution.payment.network,
        cached: purchase.execution.cached
      });
    } finally {
      clearInterval(executionHeartbeat);
    }
  } else {
    const quoteRequest = await requestServiceQuoteWithFallback({
      services: serviceCandidates,
      taskType,
      taskInput: serviceTaskInput,
      locale
    });
    selectedService = quoteRequest.service;
    if (selectedService.id !== service.id) {
      const fallbackInfo = await buildSelectionReason(selectedService, filteredServices);
      emitTrace(options, "service_selected", {
        id: selectedService.id,
        price: selectedService.price,
        endpoint: selectedService.endpoint,
        taskType: selectedService.taskType ?? taskType,
        fallbackFrom: service.id,
        attempts: quoteRequest.attempts,
        reason: fallbackInfo.reason,
        reputationPct: fallbackInfo.reputationPct,
        priceRank: fallbackInfo.priceRank,
        totalCandidates: fallbackInfo.totalCandidates,
      });
    }
    quote = quoteRequest.quote;
    const accept = pickNativeTransferAccept(quote);
    approveSpend(selectedService, accept.amount);
    resolvedTaskType = quote.paymentContext.taskType;
    hunterLog(`quote: amount=${accept.amount} wei, payTo=${accept.payTo}, network=${accept.network}`);
    hunterDebug(`quote requestHash=${quote.paymentContext.requestHash}`);
    emitTrace(options, "quote_received", {
      requestHash: quote.paymentContext.requestHash,
      amount: accept.amount,
      payTo: accept.payTo,
      network: accept.network
    });
    emitTrace(options, "payment_state", {
      status: "payment-required",
      requestHash: quote.paymentContext.requestHash,
      amount: accept.amount,
      payTo: accept.payTo,
      network: accept.network
    });

    await checkBalanceTool();
    hunterLog(`payment: sending ${accept.amount} wei to ${accept.payTo}...`);
    const payment = await makePaymentTool(accept);
    paymentTx = payment.txHash;
    hunterLog(`payment: submitted tx=${payment.txHash}`);
    emitTrace(options, "payment_state", {
      status: "payment-submitted",
      txHash: payment.txHash
    });
    emitTrace(options, "execution_started", {
      serviceId: selectedService.id,
      taskType: resolvedTaskType,
      goal
    });

    const executionStartedAt = Date.now();
    const executionHeartbeat = setInterval(() => {
      emitTrace(options, "execution_heartbeat", { elapsed: Date.now() - executionStartedAt });
    }, 10_000);
    hunterLog(`execute: submitting payment proof to ${selectedService.id}...`);
    try {
      execution = await submitPaymentAndGetResult({
        service: selectedService,
        paymentTx,
        taskType: resolvedTaskType,
        taskInput: serviceTaskInput,
        timestamp: quote.paymentContext.timestamp,
        locale
      });
    } finally {
      clearInterval(executionHeartbeat);
    }
  }

  hunterLog(`execute: result received (${execution.result.length} chars), payment=${execution.payment.status}`);
  hunterDebug(`execute: result preview: "${execution.result.slice(0, 200)}..."`);
  emitTrace(options, "payment_state", {
    status: execution.payment.status,
    txHash: execution.payment.transaction,
    network: execution.payment.network
  });

  const receiptCheck = verifyReceiptTool(execution.receipt, {
    result: execution.result,
    provider: selectedService.provider
  });
  emitTrace(options, "receipt_verified", {
    isValid: receiptCheck.isValid,
    signatureValid: receiptCheck.signatureValid,
    resultHashMatches: receiptCheck.resultHashMatches,
    providerMatches: receiptCheck.providerMatches,
    provider: execution.receipt.provider,
    requestHash: execution.receipt.requestHash
  });
  if (!receiptCheck.isValid) {
    hunterError(`verify: receipt INVALID for ${execution.receipt.requestHash}`);
    throw new HunterError(
      422,
      "RECEIPT_INVALID",
      localizeByLocale(locale, {
        en: "Receipt signature verification failed",
        zh: "回执签名验证失败"
      })
    );
  }
  hunterLog(`verify: receipt valid ✓`);
  let verification: SingleHunterRunResult["verification"];
  let riskReview: SingleHunterRunResult["riskReview"];
  if (resolvedTaskType === "smart-contract-audit") {
    if (!securityInput) {
      throw new HunterError(
        500,
        "SECURITY_INPUT_MISSING",
        "Resolved Solidity source is missing from the audit pipeline"
      );
    }
    const auditReport = parseAuditReport(execution.result);
    verification = await hireIndependentVerifier({
      services,
      auditor: selectedService,
      securityInput,
      auditReport,
      missionId,
      locale,
      options,
      approveSpend
    });
    hunterLog(
      `verify: independent verifier ${verification.service.id} completed — ` +
        `confirmed=${verification.report.summary.confirmed}, rejected=${verification.report.summary.rejected}, ` +
      `missed=${verification.report.summary.missed}`
    );
  } else if (resolvedTaskType === "onchain-investigation") {
    const sourceReport = parseOnchainRiskReport(execution.result);
    riskReview = await hireIndependentRiskVerifier({
      services,
      investigator: selectedService,
      sourceReport,
      missionId,
      locale,
      options,
      approveSpend
    });
    hunterLog(
      `verify: independent risk verifier ${riskReview.service.id} completed — ` +
        `confirmed=${riskReview.report.summary.confirmed}, mismatched=${riskReview.report.summary.mismatched}, ` +
        `status=${riskReview.report.conclusion.status}`
    );
  }
  const evaluation = evaluateResultTool(execution.result);
  hunterLog(`evaluate: score=${evaluation.score}/10 summary="${evaluation.summary}"`);
  emitTrace(options, "evaluation_completed", evaluation);

  try {
    const feedback = await submitAutoFeedback({
      service: selectedService,
      evaluation,
      missionId,
      taskType: resolvedTaskType
    });
    emitTrace(options, "feedback_submitted", feedback);
    hunterLog(`feedback: submitted for ${selectedService.id} (score=${evaluation.score})`);
  } catch (err) {
    hunterWarn(`feedback: submission failed (best-effort) — ${err instanceof Error ? err.message : String(err)}`);
  }
  const reflection = await reflectAndStoreExperience({
    missionId,
    goal,
    serviceUsed: selectedService.id,
    taskType: resolvedTaskType,
    score: evaluation.score,
    result: execution.result,
    locale,
    evaluationSummary: evaluation.summary
  });
  emitTrace(options, "tool_result", {
    tool: "reflect",
    result: {
      missionId: reflection.missionId,
      taskType: reflection.taskType,
      score: reflection.score,
      lesson: reflection.lesson
    }
  });

  const runResult: SingleHunterRunResult = {
    missionId,
    goal,
    mode: "scripted",
    service: selectedService,
    quote,
    paymentTx,
    execution,
    receiptVerified: receiptCheck.isValid,
    evaluation,
    reflection,
    verification,
    riskReview,
    finalMessage: localizeByLocale(locale, {
      en: "Scripted flow completed successfully.",
      zh: "脚本流程已成功完成。"
    })
  };
  if (emitLifecycleEvents) {
    emitTrace(options, "run_completed", {
      mode: runResult.mode,
      receiptVerified: runResult.receiptVerified,
      score: runResult.evaluation.score
    });
  }
  hunterLog(`--- executePhase done --- score=${evaluation.score}/10 service=${selectedService.id}`);
  return runResult;
}

export async function runScriptedHunter(
  goal: string,
  options: HunterRunOptions = {}
): Promise<SingleHunterRunResult> {
  return executePhase(goal, options, {
    emitLifecycleEvents: true,
    missionId: options.missionId
  });
}
