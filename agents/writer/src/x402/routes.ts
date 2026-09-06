import type { Request, Response } from "express";
import { U_TOKEN, type PaymentReceipt } from "@altananetwork/x402-server";
import {
  buildCaip2Network,
  buildX402ResourceUrl,
  calculateX402IdempotencyKey,
  calculateX402RequestHash,
  getProcessPostgresStore,
  type AssetRef,
  type ErrorResponse,
  type HexHash,
  type LanguageCode,
  type Receipt,
  type X402ExecuteSuccessResponse,
  type X402ExecutionRequest,
  type X402PaymentCompleted
} from "@rebel/shared";
import { writerConfig } from "../config.js";
import { privateKeyToAccount } from "viem/accounts";
import { validateRequestPayment } from "./payment-binding.js";
import { assertSkillRuntimeAvailable, executeTask } from "../executor.js";
import { WriterError, asWriterError } from "../errors.js";
import { localizeWriterError } from "../error-messages.js";
import { createReceipt } from "../receipt.js";
import { resolveSkillForTaskType } from "../skill-loader.js";
import { AltanaX402MerchantFactory, type X402MerchantFactory } from "./merchant.js";
import {
  FileX402ExecutionStore,
  PostgresX402ExecutionStore,
  type StoredX402Execution,
  type X402ExecutionStore
} from "./receipt-store.js";

const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const executionsByStore = new WeakMap<X402ExecutionStore, Map<string, Promise<X402ExecuteSuccessResponse>>>();

export interface X402RouteRuntime {
  chainId: number;
  publicEndpoint: string;
  providerAddress: string;
  payTo: string;
  priceAmount: string;
  paymentTimeoutSeconds: number;
  offerVersion: string;
  asset: AssetRef;
}

export interface X402RouteDependencies {
  validatePayment?(header: string, request: X402ExecutionRequest): void;
  runtime: X402RouteRuntime;
  merchantFactory: X402MerchantFactory;
  store: X402ExecutionStore;
  resolveService(taskType: string): {
    serviceId: string;
    taskType: string;
    name: string;
  };
  execute(input: { taskType: string; taskInput: string; locale?: LanguageCode }): Promise<string>;
  createResultReceipt(input: { requestHash: string; result: string }): Promise<Receipt>;
  now(): number;
}

export interface X402CoreRequest {
  body: unknown;
  queryRequestHash: unknown;
  idempotencyHeader?: string;
  paymentHeader?: string;
}

export interface X402CoreResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WriterError(400, "INVALID_PAYLOAD", `${key} is required`);
  }
  return value;
}

function parseRequest(value: unknown): X402ExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WriterError(400, "INVALID_PAYLOAD", "JSON request body is required");
  }
  const body = value as Record<string, unknown>;
  const timestamp = body.timestamp;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new WriterError(400, "INVALID_PAYLOAD", "timestamp must be a positive safe integer");
  }
  const expiresAt = body.expiresAt;
  if (
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= timestamp
  ) {
    throw new WriterError(400, "INVALID_PAYLOAD", "expiresAt must be after timestamp");
  }
  const requestHash = requireString(body, "requestHash");
  const idempotencyKey = requireString(body, "idempotencyKey");
  const paymentNonce = requireString(body, "paymentNonce");
  if (!HEX_HASH.test(requestHash) || !HEX_HASH.test(idempotencyKey) || !HEX_HASH.test(paymentNonce)) {
    throw new WriterError(
      400,
      "INVALID_PAYLOAD",
      "requestHash, idempotencyKey, and paymentNonce must be 32-byte hashes"
    );
  }
  const asset = requireString(body, "asset");
  const amount = requireString(body, "amount");
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || !/^\d+$/.test(amount)) {
    throw new WriterError(400, "INVALID_PAYLOAD", "asset or amount is invalid");
  }
  const locale = body.locale;
  if (locale !== undefined && locale !== "en-US" && locale !== "zh-CN") {
    throw new WriterError(400, "INVALID_PAYLOAD", "locale must be en-US or zh-CN");
  }
  return {
    missionId: requireString(body, "missionId"),
    serviceId: requireString(body, "serviceId"),
    offerVersion: requireString(body, "offerVersion"),
    taskType: requireString(body, "taskType"),
    taskInput: requireString(body, "taskInput"),
    timestamp,
    expiresAt,
    paymentNonce: paymentNonce as HexHash,
    asset: asset as `0x${string}`,
    amount,
    requestHash: requestHash as HexHash,
    idempotencyKey: idempotencyKey as HexHash,
    ...(locale ? { locale } : {})
  };
}

function validateStoredRecord(record: StoredX402Execution, request: X402ExecutionRequest): void {
  if (record.requestHash !== request.requestHash || record.serviceId !== request.serviceId) {
    throw new WriterError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key is already bound to a different service request"
    );
  }
}

function completedResponse(response: X402ExecuteSuccessResponse, cached: boolean): X402CoreResponse {
  return {
    status: 200,
    body: { ...response, cached },
    headers: {
      "Cache-Control": "private, no-store",
      "X-Payment-Transaction": response.payment.transaction,
      "X-Request-Hash": response.requestHash
    }
  };
}

function toPayment(
  receipt: PaymentReceipt,
  runtime: X402RouteRuntime
): X402PaymentCompleted {
  if (!HEX_HASH.test(receipt.txHash) || !/^0x[\da-f]{40}$/i.test(receipt.payer) ||
      receipt.token.toLowerCase() !== runtime.asset.address?.toLowerCase() ||
      receipt.amount.toString() !== runtime.priceAmount) {
    throw new WriterError(502, "SETTLEMENT_RECEIPT_MISMATCH", "Facilitator receipt does not match the accepted payment");
  }
  return {
    status: "payment-completed",
    rail: "x402",
    transaction: receipt.txHash,
    network: buildCaip2Network(runtime.chainId),
    payer: receipt.payer,
    recipient: runtime.payTo as `0x${string}`,
    amount: {
      asset: {
        ...runtime.asset,
        address: receipt.token
      },
      amount: receipt.amount.toString()
    },
    transferMethod: receipt.rail
  };
}

async function executeSettledRequest(
  request: X402ExecutionRequest,
  payment: X402PaymentCompleted,
  deps: X402RouteDependencies
): Promise<X402ExecuteSuccessResponse> {
  let pendingExecutions = executionsByStore.get(deps.store);
  if (!pendingExecutions) {
    pendingExecutions = new Map();
    executionsByStore.set(deps.store, pendingExecutions);
  }
  const existing = pendingExecutions.get(request.idempotencyKey);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    try {
      const result = await deps.execute({
        taskType: request.taskType,
        taskInput: request.taskInput,
        locale: request.locale
      });
      const receipt = await deps.createResultReceipt({ requestHash: request.requestHash, result });
      const response: X402ExecuteSuccessResponse = {
        result,
        receipt,
        payment,
        requestHash: request.requestHash,
        idempotencyKey: request.idempotencyKey,
        cached: false
      };
      await deps.store.save({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        serviceId: request.serviceId,
        request,
        payment,
        response,
        updatedAt: deps.now()
      });
      return response;
    } catch (error) {
      await deps.store.save({
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        serviceId: request.serviceId,
        request,
        payment,
        lastError: "Paid execution failed; retry the same request to resume without payment",
        updatedAt: deps.now()
      });
      throw error;
    }
  })().finally(() => {
    pendingExecutions!.delete(request.idempotencyKey);
  });
  pendingExecutions.set(request.idempotencyKey, pending);
  return pending;
}

export async function handleX402Core(
  input: X402CoreRequest,
  deps: X402RouteDependencies
): Promise<X402CoreResponse> {
  const request = parseRequest(input.body);
  const expectedRequestHash = calculateX402RequestHash({
    missionId: request.missionId,
    chainId: deps.runtime.chainId,
    serviceId: request.serviceId,
    offerVersion: request.offerVersion,
    taskType: request.taskType,
    taskInput: request.taskInput,
    timestamp: request.timestamp,
    expiresAt: request.expiresAt,
    paymentNonce: request.paymentNonce,
    assetAddress: request.asset,
    amount: request.amount,
    providerAddress: deps.runtime.providerAddress,
    resourcePath: "/execute/x402"
  });
  if (request.requestHash !== expectedRequestHash || input.queryRequestHash !== expectedRequestHash) {
    throw new WriterError(400, "REQUEST_HASH_MISMATCH", "Request body or URL does not match requestHash");
  }
  const expectedIdempotencyKey = calculateX402IdempotencyKey({
    missionId: request.missionId,
    serviceId: request.serviceId,
    requestHash: request.requestHash
  });
  if (
    request.idempotencyKey !== expectedIdempotencyKey ||
    input.idempotencyHeader !== expectedIdempotencyKey
  ) {
    throw new WriterError(400, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key does not match the request");
  }

  const stored = await deps.store.get(request.idempotencyKey);
  if (stored) {
    validateStoredRecord(stored, request);
    if (stored.response) {
      return completedResponse(stored.response, true);
    }
    if (stored.payment) {
      const response = await executeSettledRequest(request, stored.payment, deps);
      return completedResponse(response, false);
    }
    if (stored.settlement) {
      throw new WriterError(409, "SETTLEMENT_UNCERTAIN", "Payment may have settled. Reconcile this original request; do not submit a new payment.");
    }
  }

  // Current offers govern NEW purchases, never delivery of a previously paid request.
  const service = deps.resolveService(request.taskType);
  if (service.serviceId !== request.serviceId) {
    throw new WriterError(400, "SERVICE_MISMATCH", "serviceId does not match taskType");
  }
  if (request.offerVersion !== deps.runtime.offerVersion) {
    throw new WriterError(409, "OFFER_VERSION_MISMATCH", "Service offer version is no longer active");
  }
  if (request.asset.toLowerCase() !== deps.runtime.asset.address?.toLowerCase() || request.amount !== deps.runtime.priceAmount) {
    throw new WriterError(409, "OFFER_PRICE_MISMATCH", "Request asset or amount no longer matches the offer");
  }

  if (
    request.expiresAt - request.timestamp > deps.runtime.paymentTimeoutSeconds ||
    deps.now() > request.expiresAt ||
    deps.now() < request.timestamp - 5
  ) {
    throw new WriterError(408, "QUOTE_EXPIRED", "x402 service request timestamp is outside the payment window");
  }
  const resourceUrl = buildX402ResourceUrl(deps.runtime.publicEndpoint, request.requestHash);
  const merchant = deps.merchantFactory.get({
    requestHash: request.requestHash,
    resourceUrl,
    description: `${service.name} Service`,
    price: deps.runtime.priceAmount
  });

  if (!input.paymentHeader) {
    const challenge = await merchant.requirePayment(null);
    if (challenge.status !== 402) throw new WriterError(502, "INVALID_PAYMENT_CHALLENGE", "Merchant did not require payment");
    return { status: 402, body: challenge.body, headers: { "Cache-Control": "private, no-store" } };
  }
  const intent: StoredX402Execution = {
    idempotencyKey: request.idempotencyKey, requestHash: request.requestHash,
    serviceId: request.serviceId, request,
    settlement: { state: "attempting", startedAt: deps.now() }, updatedAt: deps.now()
  };
  deps.validatePayment?.(input.paymentHeader, request);
  if (!await deps.store.beginSettlement(intent)) {
    // Another process won the claim. Re-read its paid/cached/pending state; never call facilitator twice.
    return handleX402Core(input, deps);
  }
  let payment: X402PaymentCompleted;
  try {
    const guarded = await merchant.requirePayment(input.paymentHeader);
    if (guarded.status === 402) {
      // A facilitator may return 402 after broadcast/timeout. It is not proof of no payment.
      throw new Error("Signed settlement was not confirmed");
    }
    payment = toPayment(guarded.receipt, deps.runtime);
    await deps.store.save({
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      serviceId: request.serviceId,
      request,
      payment,
      updatedAt: deps.now()
    });
  } catch {
    await deps.store.save({ ...intent, settlement: { state: "uncertain", startedAt: intent.settlement!.startedAt }, updatedAt: deps.now() });
    throw new WriterError(503, "SETTLEMENT_UNCERTAIN", "Payment outcome is unknown. Reconcile this original request before any further payment.");
  }
  const response = await executeSettledRequest(request, payment, deps);
  return completedResponse(response, false);
}

async function productionDependencies(): Promise<X402RouteDependencies> {
  const token = U_TOKEN[writerConfig.chainId as 56 | 97];
  if (!token) {
    throw new Error(`No x402 $U token is configured for chain ${writerConfig.chainId}`);
  }
  const postgres = await getProcessPostgresStore(`agora-writer-${writerConfig.serviceProfile}`);
  return {
    validatePayment: (header, request) => validateRequestPayment(header, request, {
      chainId: writerConfig.chainId, payTo: writerConfig.x402.payTo,
      facilitatorAddress: privateKeyToAccount(writerConfig.x402.facilitatorPrivateKey as `0x${string}`).address
    }),
    runtime: {
      chainId: writerConfig.chainId,
      publicEndpoint: writerConfig.publicEndpoint,
      providerAddress: writerConfig.writerAddress,
      payTo: writerConfig.x402.payTo,
      priceAmount: writerConfig.x402.priceAmount,
      paymentTimeoutSeconds: Math.min(writerConfig.paymentTimeoutSeconds, 480),
      offerVersion: "2",
      asset: {
        chainId: writerConfig.chainId,
        kind: "erc20",
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals
      }
    },
    merchantFactory: new AltanaX402MerchantFactory(),
    store: postgres
      ? new PostgresX402ExecutionStore(postgres)
      : new FileX402ExecutionStore(writerConfig.x402.receiptStorePath),
    resolveService(taskType) {
      const skill = resolveSkillForTaskType(taskType);
      assertSkillRuntimeAvailable(skill);
      return {
        serviceId: skill.config.id,
        taskType: skill.canonicalTaskType,
        name: skill.config.name
      };
    },
    execute: executeTask,
    createResultReceipt: createReceipt,
    now: () => Math.floor(Date.now() / 1000)
  };
}

let productionDeps: Promise<X402RouteDependencies> | undefined;

export async function x402ExecuteHandler(req: Request, res: Response): Promise<void> {
  const locale = req.body?.locale === "zh-CN" ? "zh-CN" : "en-US";
  try {
    if (!writerConfig.x402.enabled) {
      throw new WriterError(404, "X402_DISABLED", "x402 service endpoint is disabled");
    }
    productionDeps ??= productionDependencies();
    const dependencies = await productionDeps;
    const response = await handleX402Core(
      {
        body: req.body,
        queryRequestHash: req.query.requestHash,
        idempotencyHeader: req.get("Idempotency-Key") ?? undefined,
        paymentHeader: req.get("X-PAYMENT") ?? req.get("PAYMENT-SIGNATURE") ?? undefined
      },
      dependencies
    );
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.status(response.status).json(response.body);
  } catch (error) {
    const writerError = asWriterError(error);
    console.error(JSON.stringify({
      event: "x402_request_failed",
      service: writerConfig.serviceProfile,
      code: writerError.code,
      message: writerError.message
    }));
    const localized = localizeWriterError(writerError, locale);
    const payload: ErrorResponse = {
      code: localized.code,
      message: localized.message,
      details: localized.details
    };
    res.status(localized.status).json(payload);
  }
}
