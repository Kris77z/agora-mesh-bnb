import { readFile } from "node:fs/promises";
import {
  buildCaip2Network,
  withLocalFileLock,
  getProcessPostgresStore,
  type HunterTraceEvent,
  type ServiceInfo,
  type X402ExecuteSuccessResponse,
  type X402PaymentRequirement
} from "@rebel/shared";
import { hunterConfig } from "./config.js";
import { evaluateResultTool, verifyReceiptTool } from "./tools/verify.js";
import { discoverServices } from "./tools/discover.js";
import { resolveSecurityTaskInput } from "./security-input.js";
import { openHunterMissionStore } from "./mission-store.js";
import { openHunterRunStore } from "./run-store.js";
import {
  createPhaseSpendApprover,
  hireIndependentVerifier
} from "./scripted-flow.js";
import { parseAuditReport } from "./security-pipeline.js";
import type { SingleHunterRunResult } from "./run-types.js";
import { browserAuthorityContext } from './integrations/altana/browser-context.js';

interface ReceiptStoreFile {
  records?: Record<string, {
    requestHash?: string;
    serviceId?: string;
    request?: {
      missionId?: string;
      requestHash?: string;
      serviceId?: string;
      idempotencyKey?: string;
      [key: string]: unknown;
    };
    payment?: {status?: string; payer?: string; transaction?: string};
    response?: X402ExecuteSuccessResponse;
  }>;
}

export async function replayPaidAuditOrder(input: {
  record: NonNullable<ReceiptStoreFile['records']>[string]; missionId: string; requestHash: string;
  serviceId: string; endpoint: string; payer?: string;
}, fetcher: typeof fetch = fetch): Promise<X402ExecuteSuccessResponse> {
  const {record, missionId, requestHash, serviceId, payer} = input;
  const request = record.request;
  if (!request || request.missionId !== missionId || request.requestHash !== requestHash || request.serviceId !== serviceId ||
      !request.idempotencyKey || record.payment?.status !== 'payment-completed' || !record.payment.transaction ||
      (payer && record.payment.payer?.toLowerCase() !== payer.toLowerCase())) throw new Error('Original paid order does not match this mission and wallet');
  const response = await fetcher(`${input.endpoint.replace(/\/$/, '')}/execute/x402?requestHash=${requestHash}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey},
    body: JSON.stringify(request), signal: AbortSignal.timeout(900_000)
  });
  if (!response.ok) throw new Error('The paid audit is not ready. Its original payment is retained.');
  const body = await response.json() as X402ExecuteSuccessResponse;
  if (body.requestHash !== requestHash || body.payment?.transaction !== record.payment.transaction ||
      body.payment.payer?.toLowerCase() !== record.payment.payer?.toLowerCase()) throw new Error('Recovered payment binding mismatch');
  return body;
}

function eventData(event: HunterTraceEvent | undefined): Record<string, unknown> | undefined {
  return event?.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
}

function recoveredRequirement(
  service: ServiceInfo,
  execution: X402ExecuteSuccessResponse
): X402PaymentRequirement {
  const payment = execution.payment;
  if (!payment.amount.asset.address) {
    throw new Error("Recovered x402 payment is missing its ERC-20 asset address");
  }
  return {
    x402Version: 2,
    error: "Recovered from a confirmed, already-settled x402 request",
    resource: {
      url: `${service.endpoint.replace(/\/$/, "")}/execute/x402?requestHash=${execution.requestHash}`,
      description: `${service.name} recovered delivery`,
      mimeType: "application/json"
    },
    accepts: [{
      scheme: "exact",
      network: payment.network || buildCaip2Network(hunterConfig.chainId),
      asset: payment.amount.asset.address,
      payTo: payment.recipient,
      amount: payment.amount.amount,
      maxTimeoutSeconds: 0,
      extra: {
        name: payment.amount.asset.symbol,
        version: "1",
        assetTransferMethod: payment.transferMethod === "eip3009" ? "eip3009" : "permit2-exact"
      }
    }]
  };
}

export async function recoverPaidAudit(missionId: string, onProgress: (stage: string) => void = () => {}): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(missionId)) throw new Error('Invalid mission ID');
  const authorityId = browserAuthorityContext.getStore()?.authorityId;
  return withLocalFileLock(`${hunterConfig.runStorePath}.${authorityId ?? 'cli'}.${missionId}.recovery`, () => recoverPaidAuditLocked(missionId, onProgress), 100);
}

async function recoverPaidAuditLocked(missionId: string, onProgress: (stage: string) => void): Promise<void> {
  const authorityId = browserAuthorityContext.getStore()?.authorityId;
  const missionStore = await openHunterMissionStore(hunterConfig.missionStorePath);
  const runStore = await openHunterRunStore(
    authorityId ? `${hunterConfig.runStorePath}.${authorityId}.json` : hunterConfig.runStorePath,
    authorityId ? `hunter-${authorityId}` : 'hunter-run'
  );
  const mission = await missionStore.get(missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  if (authorityId && mission.authorityId !== authorityId) throw new Error('Mission belongs to a different browser Authority');
  if (mission.status === "completed" && mission.source === "recovered-evidence" && mission.result) {
    const run = await runStore.get(missionId);
    if (!run) throw new Error("Recovered mission has no durable run record");
    if (run.events.length > mission.events.length || run.events.some((event, index) =>
      JSON.stringify(event) !== JSON.stringify(mission.events[index])
    )) {
      throw new Error("Recovered mission and durable run histories diverged");
    }
    const recovered = await runStore.completeRecovered(
      missionId,
      mission.result,
      mission.events.slice(run.events.length)
    );
    process.stdout.write(`${JSON.stringify({
      event: "paid_audit_run_state_reconciled",
      missionId,
      status: recovered.status,
      eventCount: recovered.events.length
    }, null, 2)}\n`);
    return;
  }
  const resumableCodes = new Set(["X402_SERVICE_UNREACHABLE", "X402_PAYMENT_REQUIRED", "X402_EXECUTION_FAILED", "X402_SETTLEMENT_UNCERTAIN"]);
  if (mission.status !== "failed" || !resumableCodes.has(mission.error?.code ?? "")) {
    throw new Error("Only a failed mission with a reconciled x402 delivery can be resumed");
  }
  const alreadyPaidVerifier = mission.events.some((event) =>
    event.type === "payment_confirmed" && eventData(event)?.role === "verifier"
  );
  if (alreadyPaidVerifier) {
    throw new Error("Mission already contains a confirmed Verifier payment");
  }

  const selection = eventData(mission.events.find((event) => event.type === "service_selected"));
  const securityEvent = eventData(mission.events.find((event) => event.type === "security_input_resolved"));
  const requirementEvent = eventData(mission.events.find((event) =>
    event.type === "x402_requirement_received" && eventData(event)?.role !== "verifier"
  ));
  const auditorServiceId = typeof selection?.id === "string" ? selection.id : undefined;
  const sourceHash = typeof securityEvent?.sourceHash === "string" ? securityEvent.sourceHash : undefined;
  const requestHash = typeof requirementEvent?.requestHash === "string"
    ? requirementEvent.requestHash
    : undefined;
  if (!auditorServiceId || !sourceHash || !requestHash) {
    throw new Error("Mission is missing Auditor selection, source hash, or x402 request evidence");
  }

  const services = await discoverServices();
  const auditor = services.find((service) => service.id === auditorServiceId);
  if (!auditor) throw new Error(`Auditor service is unavailable: ${auditorServiceId}`);
  const securityInput = await resolveSecurityTaskInput(mission.goal);
  if (securityInput.sourceHash !== sourceHash) {
    throw new Error("Recovered mission source no longer matches its persisted source hash");
  }

  const auditorStorePaths = hunterConfig.altana.paymentEvidencePaths;
  if (!auditorStorePaths.length) throw new Error("Auditor receipt store is not configured");
  const postgres = await getProcessPostgresStore("agora-hunter");
  let receiptStore: ReceiptStoreFile;
  if (postgres) {
    const records: NonNullable<ReceiptStoreFile["records"]> = {};
    for (const record of await postgres.listX402ExecutionEvidence([auditorServiceId])) {
      records[record.idempotencyKeyHash] = {
        requestHash: `0x${record.requestHash}`,
        serviceId: record.serviceId,
        payment: record.payment as NonNullable<ReceiptStoreFile["records"]>[string]["payment"],
        request: record.request as NonNullable<ReceiptStoreFile["records"]>[string]["request"],
        response: record.response as X402ExecuteSuccessResponse | undefined
      };
    }
    receiptStore = { records };
  } else {
    const stores = await Promise.all(auditorStorePaths.map(async (storePath) => {
      try { return JSON.parse(await readFile(storePath, "utf8")) as ReceiptStoreFile; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    }));
    receiptStore = {records: Object.fromEntries(stores.flatMap((store, index) =>
      Object.entries(store.records ?? {}).map(([key, value]) => [`${index}:${key}`, value])))};
  }
  const recovered = Object.values(receiptStore.records ?? {}).find((record) =>
    record.requestHash === requestHash && record.serviceId === auditorServiceId
  );
  if (recovered && !recovered.response) {
    onProgress('Recovering the original paid audit; no new Auditor payment');
    recovered.response = await replayPaidAuditOrder({record: recovered, missionId, requestHash,
      serviceId: auditorServiceId, endpoint: auditor.endpoint, payer: browserAuthorityContext.getStore()?.walletAddress});
  }
  if (!recovered?.response) {
    throw new Error("The confirmed Auditor payment has not produced a recoverable response yet");
  }
  if (recovered.request && recovered.request.missionId !== missionId) {
    throw new Error("Recovered Auditor request belongs to a different mission");
  }
  const scopedPayer = browserAuthorityContext.getStore()?.walletAddress;
  if (scopedPayer && recovered.response.payment.payer?.toLowerCase() !== scopedPayer.toLowerCase()) throw new Error('Recovered receipt belongs to a different wallet');
  const receiptCheck = verifyReceiptTool(recovered.response.receipt, {
    result: recovered.response.result,
    provider: auditor.provider
  });
  if (!receiptCheck.isValid) throw new Error("Recovered Auditor receipt signature is invalid");
  const auditReport = parseAuditReport(recovered.response.result);

  const recoveredEvents: HunterTraceEvent[] = [];
  const emit = (event: HunterTraceEvent) => recoveredEvents.push(event);
  const verifier = services.find((service) => service.taskType === "finding-verification");
  if (!verifier?.asset) throw new Error("Independent Verifier offer is missing its payment asset");
  onProgress('Verifying the recovered report within the remaining Authority budget');
  const verification = await hireIndependentVerifier({
    services,
    auditor,
    securityInput,
    auditReport,
    missionId,
    locale: "zh-CN",
    options: { locale: "zh-CN", onEvent: emit },
    approveSpend: createPhaseSpendApprover({ asset: verifier.asset, amount: verifier.price })
  });
  const evaluation = evaluateResultTool(recovered.response.result);
  const completedAt = Date.now();
  const recoveryEvents: HunterTraceEvent[] = [
    {
      type: "payment_confirmed",
      at: new Date().toISOString(),
      data: {
        role: "auditor",
        requestHash,
        txHash: recovered.response.payment.transaction,
        amount: recovered.response.payment.amount,
        recipient: recovered.response.payment.recipient,
        network: recovered.response.payment.network,
        cached: true,
        recovered: true
      }
    },
    {
      type: "receipt_verified",
      at: new Date().toISOString(),
      data: {
        role: "auditor",
        isValid: true,
        provider: recovered.response.receipt.provider,
        requestHash: recovered.response.receipt.requestHash,
        recovered: true
      }
    },
    ...recoveredEvents,
    {
      type: "evaluation_completed",
      at: new Date().toISOString(),
      data: evaluation
    },
    {
      type: "run_completed",
      at: new Date().toISOString(),
      data: { mode: "scripted", receiptVerified: true, score: evaluation.score, recovered: true }
    }
  ];
  const result: SingleHunterRunResult = {
    missionId,
    goal: mission.goal,
    mode: "scripted",
    service: auditor,
    quote: recoveredRequirement(auditor, recovered.response),
    paymentTx: recovered.response.payment.transaction,
    execution: recovered.response,
    receiptVerified: true,
    evaluation,
    verification,
    finalMessage: "已从确认付款的 Auditor 回执恢复交付，并完成独立 Verifier。"
  };
  await missionStore.save({
    ...mission,
    status: "completed",
    source: "recovered-evidence",
    events: [...mission.events, ...recoveryEvents],
    result,
    error: undefined,
    completedAt
  });
  await runStore.completeRecovered(missionId, result, recoveryEvents);
  process.stdout.write(`${JSON.stringify({
    event: "paid_audit_resumed",
    missionId,
    sourceHash,
    auditor: {
      serviceId: auditor.id,
      paymentTx: recovered.response.payment.transaction,
      receiptVerified: true,
      findings: auditReport.vulnerabilities.length
    },
    verifier: {
      serviceId: verification.service.id,
      paymentTx: verification.paymentTx,
      receiptVerified: verification.receiptVerified,
      engine: verification.report.engine,
      summary: verification.report.summary
    }
  }, null, 2)}\n`);
}
