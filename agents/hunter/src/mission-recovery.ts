import { readFile } from "node:fs/promises";
import {
  calculateX402RequestHash,
  calculateX402IdempotencyKey,
  sameAddress,
  type PostgresCoordinationStore,
  type X402ExecutionRequest,
  HunterTraceEvent,
  ServiceInfo,
  VerificationReport,
  X402ExecuteSuccessResponse,
  X402PaymentCompleted
} from "@rebel/shared";
import { verifyReceiptTool } from "./tools/verify.js";
import { readExperiences, type Experience } from "./memory.js";
import type { HunterRunResult } from "./run-types.js";
import type { StoredHunterMission } from "./mission-store.js";

interface ReceiptRecord {
  request: X402ExecutionRequest;
  requestHash: string;
  idempotencyKey: string;
  serviceId: string;
  updatedAt: number;
  payment: X402PaymentCompleted;
  response: X402ExecuteSuccessResponse;
}

interface ReceiptStoreFile {
  records?: Record<string, Partial<ReceiptRecord>>;
}

function isReceiptRecord(value: Partial<ReceiptRecord>): value is ReceiptRecord {
  const complete = typeof value.serviceId === "string" &&
    Boolean(value.request) &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt! > 0 &&
    value.payment?.status === "payment-completed" &&
    value.payment.rail === "x402" &&
    typeof value.response?.result === "string" &&
    value.response.payment?.transaction === value.payment.transaction;
  if (!complete) return false;
  try {
    const record = value as ReceiptRecord;
    const { request, response, payment } = record;
    const hash = calculateX402RequestHash({
      missionId: request.missionId, chainId: payment.amount.asset.chainId,
      serviceId: request.serviceId, offerVersion: request.offerVersion, taskType: request.taskType,
      taskInput: request.taskInput, timestamp: request.timestamp, expiresAt: request.expiresAt,
      paymentNonce: request.paymentNonce, assetAddress: request.asset, amount: request.amount,
      providerAddress: payment.recipient, resourcePath: "/execute/x402"
    });
    const key = calculateX402IdempotencyKey({ missionId: request.missionId, serviceId: request.serviceId, requestHash: hash });
    return record.serviceId === request.serviceId && record.requestHash === hash && request.requestHash === hash &&
      response.requestHash === hash && response.receipt.requestHash === hash &&
      record.idempotencyKey === key && request.idempotencyKey === key && response.idempotencyKey === key &&
      request.amount === payment.amount.amount && payment.amount.asset.kind === "erc20" &&
      sameAddress(request.asset, payment.amount.asset.address!) &&
      JSON.stringify(response.payment) === JSON.stringify(payment) &&
      response.receipt.signatureScheme === "agora-request-result-v2" &&
      verifyReceiptTool(response.receipt, { result: response.result, provider: payment.recipient }).isValid;
  } catch { return false; }
}

async function readReceiptRecords(
  paths: string[],
  database?: PostgresCoordinationStore
): Promise<ReceiptRecord[]> {
  if (database) {
    const rows = await database.listX402ExecutionEvidence();
    return rows.flatMap((row) => {
      const request = row.request as X402ExecutionRequest | undefined;
      const value: Partial<ReceiptRecord> = {
        request,
        requestHash: request?.requestHash ?? `0x${row.requestHash}`,
        idempotencyKey: request?.idempotencyKey,
        serviceId: row.serviceId,
        updatedAt: Math.floor(Date.parse(row.updatedAt) / 1_000),
        payment: row.payment as X402PaymentCompleted | undefined,
        response: row.response as X402ExecuteSuccessResponse | undefined
      };
      return isReceiptRecord(value) ? [value] : [];
    });
  }
  const records: ReceiptRecord[] = [];
  for (const storePath of paths) {
    try {
      const parsed = JSON.parse(await readFile(storePath, "utf8")) as ReceiptStoreFile;
      records.push(...Object.values(parsed.records ?? {}).filter(isReceiptRecord));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return records;
}

function uniqueRecord(
  records: ReceiptRecord[],
  predicate: (record: ReceiptRecord) => boolean
): ReceiptRecord | undefined {
  const matches = new Map(records.filter(predicate).map((record) => [record.idempotencyKey, record]));
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function serviceFromReceipt(record: ReceiptRecord, role: "auditor" | "verifier"): ServiceInfo {
  const asset = record.payment.amount.asset;
  return {
    id: record.serviceId,
    name: role === "auditor" ? "Smart Contract Auditor" : "Independent Finding Verifier",
    description: role === "auditor"
      ? "Audit Solidity contracts for loss-of-funds vulnerabilities"
      : "Re-check structured findings with deterministic static analysis",
    endpoint: "",
    taskType: role === "auditor" ? "smart-contract-audit" : "finding-verification",
    skills: role === "auditor"
      ? ["solidity", "vulnerability", "bnb", "evm"]
      : ["solidity", "static-analysis", "finding-verification", "bnb", "evm"],
    price: record.payment.amount.amount,
    currency: asset.symbol,
    asset,
    agentId: `${asset.chainId}:${record.payment.recipient.toLowerCase()}`,
    paymentRails: ["x402"],
    offerVersion: "1",
    network: record.payment.network,
    provider: record.payment.recipient
  };
}

function recoveredQuote(record: ReceiptRecord) {
  return {
    x402Version: 2 as const,
    error: "Recovered from confirmed x402 evidence; the original pre-payment challenge was not persisted.",
    resource: { url: "recovered://confirmed-x402-receipt" },
    accepts: []
  };
}

function parseVerificationReport(result: string): VerificationReport | undefined {
  try {
    const parsed = JSON.parse(result) as Partial<VerificationReport>;
    if (
      typeof parsed.sourceHash !== "string" ||
      !parsed.engine ||
      !Array.isArray(parsed.verifications) ||
      !parsed.summary
    ) {
      return undefined;
    }
    return parsed as VerificationReport;
  } catch {
    return undefined;
  }
}

function iso(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString();
}

function paymentEvents(
  missionId: string,
  record: ReceiptRecord,
  extra?: Record<string, unknown>
): HunterTraceEvent[] {
  return [
    {
      type: "payment_confirmed",
      at: iso(record.response.receipt.timestamp),
      data: {
        missionId,
        serviceId: record.serviceId,
        txHash: record.payment.transaction,
        amount: record.payment.amount,
        recipient: record.payment.recipient,
        network: record.payment.network,
        recoveredFromReceipt: true,
        ...extra
      }
    },
    {
      type: "receipt_verified",
      at: iso(record.response.receipt.timestamp),
      data: {
        missionId,
        serviceId: record.serviceId,
        isValid: true,
        provider: record.response.receipt.provider,
        requestHash: record.response.receipt.requestHash,
        recoveredFromReceipt: true
      }
    }
  ];
}

export async function recoverMissionFromEvidence(input: {
  missionId: string;
  chainId: number;
  authorityId?: string;
  receiptStorePaths: string[];
  database?: PostgresCoordinationStore;
  experiences?: Experience[];
}): Promise<StoredHunterMission | undefined> {
  const experiences = input.experiences ?? await readExperiences();
  const experience = experiences.find((item) => item.missionId === input.missionId);
  if (!experience) return undefined;

  const receipts = (await readReceiptRecords(input.receiptStorePaths, input.database)).filter((record) =>
    record.request.missionId === input.missionId && record.payment.network === `eip155:${input.chainId}` &&
    record.payment.amount.asset.chainId === input.chainId);
  const auditor = uniqueRecord(
    receipts,
    (record) => record.serviceId === experience.serviceUsed && record.request.taskType === "smart-contract-audit"
  );
  if (!auditor) return undefined;
  const verifier = uniqueRecord(
    receipts,
    (record) => record.serviceId !== auditor.serviceId &&
      record.request.taskType === "finding-verification" &&
      sameAddress(record.payment.payer, auditor.payment.payer) &&
      !sameAddress(record.payment.recipient, auditor.payment.recipient)
  );
  const verificationReport = verifier ? parseVerificationReport(verifier.response.result) : undefined;
  if (!verifier || !verificationReport) return undefined;
  try {
    const source = JSON.parse(auditor.request.taskInput) as { sourceHash?: string };
    if (!source.sourceHash || verificationReport.sourceHash !== source.sourceHash) return undefined;
  } catch { return undefined; }
  const auditorService = serviceFromReceipt(auditor, "auditor");
  const result: HunterRunResult = {
    missionId: input.missionId,
    goal: experience.goal,
    mode: "scripted",
    service: auditorService,
    quote: recoveredQuote(auditor),
    paymentTx: auditor.payment.transaction,
    execution: auditor.response,
    receiptVerified: true,
    evaluation: { score: experience.score, summary: experience.lesson },
    reflection: experience,
    verification: verifier && verificationReport ? {
      service: serviceFromReceipt(verifier, "verifier"),
      quote: recoveredQuote(verifier),
      paymentTx: verifier.payment.transaction,
      execution: verifier.response,
      receiptVerified: true,
      report: verificationReport
    } : undefined,
    finalMessage: "Recovered from confirmed x402 payments, signed delivery receipts, and Hunter experience memory."
  };
  const events: HunterTraceEvent[] = [
    {
      type: "run_started",
      at: iso(auditor.response.receipt.timestamp),
      data: { missionId: input.missionId, mode: "scripted", goal: experience.goal, recoveredFromEvidence: true }
    },
    ...paymentEvents(input.missionId, auditor),
    ...(verifier ? [
      {
        type: "verifier_hired" as const,
        at: iso(verifier.response.receipt.timestamp),
        data: { missionId: input.missionId, serviceId: verifier.serviceId, recoveredFromReceipt: true }
      },
      ...paymentEvents(input.missionId, verifier, { role: "verifier" })
    ] : []),
    ...(verificationReport?.verifications.map((verification) => ({
      type: "finding_verified" as const,
      at: iso(verifier!.response.receipt.timestamp),
      data: { missionId: input.missionId, ...verification, recoveredFromReceipt: true }
    })) ?? []),
    {
      type: "evaluation_completed",
      at: iso(experience.timestamp),
      data: { missionId: input.missionId, score: experience.score, summary: experience.lesson }
    },
    {
      type: "run_completed",
      at: iso(experience.timestamp),
      data: { missionId: input.missionId, mode: "scripted", receiptVerified: true, score: experience.score }
    }
  ];
  return {
    missionId: input.missionId,
    goal: experience.goal,
    chainId: input.chainId,
    authorityId: input.authorityId,
    mode: "scripted",
    status: "completed",
    source: "recovered-evidence",
    events,
    result,
    createdAt: auditor.response.receipt.timestamp * 1_000,
    completedAt: experience.timestamp * 1_000
  };
}
