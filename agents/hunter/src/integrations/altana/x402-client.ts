import { randomBytes } from "node:crypto";
import { browserAuthorityContext } from './browser-context.js';
import { webcrypto } from "node:crypto";
import { BNB_TESTNET, signX402Payment } from "@altananetwork/sdk";
import {
  buildX402ResourceUrl,
  calculateX402IdempotencyKey,
  calculateX402RequestHash,
  getProcessPostgresStore,
  parseX402PaymentRequirement,
  sameAddress,
  sameAsset,
  selectX402Accept,
  type AuthorityRecord,
  type HexAddress,
  type HexHash,
  type LanguageCode,
  type Money,
  type ServiceInfo,
  type X402Accept,
  type X402ExecuteSuccessResponse,
  type X402ExecutionRequest,
  type X402PaymentRequirement
} from "@rebel/shared";
import { hunterConfig } from "../../config.js";
import { HunterError } from "../../errors.js";
import { loadActiveAltanaAuthority } from "./authority.js";
import {
  readAuthoritySpending,
  type AuthoritySpendSummary
} from "./authority-spending.js";
import { restoreAltanaSession } from "./session-codec.js";
import {
  FileX402PurchaseStore,
  PostgresX402PurchaseStore,
  purchaseKey,
  type StoredX402Purchase,
  type X402PurchaseStore
} from "./purchase-store.js";

const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const authoritySpendReservations = new Map<string, bigint>();

function ensureWebCrypto(): void {
  const runtimeCrypto = (
    globalThis as unknown as { crypto?: { getRandomValues?: unknown } }
  ).crypto;
  if (typeof runtimeCrypto?.getRandomValues === "function") {
    return;
  }
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: false
  });
}

export interface X402PurchaseInput {
  missionId: string;
  service: ServiceInfo;
  taskType: string;
  taskInput: string;
  locale?: LanguageCode;
  onRequirement?: (input: {
    requirement: X402PaymentRequirement;
    selectedAccept: X402Accept;
    request: X402ExecutionRequest;
  }) => void;
}

export interface X402PurchaseResult {
  requirement: X402PaymentRequirement;
  selectedAccept: X402Accept;
  execution: X402ExecuteSuccessResponse;
  request: X402ExecutionRequest;
}

export interface X402ClientDependencies {
  purchaseStore?: X402PurchaseStore;
  now(): number;
  quoteFetch(url: string, init: RequestInit): Promise<Response>;
  paidFetch(url: string, init: RequestInit, approved: X402Accept): Promise<Response>;
}

export interface SignedX402DeliveryInput {
  url: string;
  init: RequestInit;
  attempts: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Retries delivery only. The caller must build and sign `init` once so every
 * attempt carries the same requestHash, idempotency key, body, and payment signature.
 */
export async function deliverSignedX402WithRetry(
  input: SignedX402DeliveryInput
): Promise<Response> {
  if (!Number.isInteger(input.attempts) || input.attempts < 1) {
    throw new Error("x402 delivery attempts must be a positive integer");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input.url, input.init);
      if (![502, 503, 504].includes(response.status) || attempt === input.attempts) return response;
      const body = await response.clone().json().catch(() => undefined) as { code?: string } | undefined;
      if (body?.code === "SETTLEMENT_UNCERTAIN") return response;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function validateX402AuthorityPolicy(
  authority: AuthorityRecord,
  approved: X402Accept
): void {
  if (!authority.allowedCalls.some((call) => sameAddress(call.to, approved.payTo))) {
    throw new HunterError(
      403,
      "AUTHORITY_CALL_NOT_ALLOWED",
      "x402 recipient is not on the active authority allowlist"
    );
  }
  const spendLimit = authority.spendLimits.find(
    (limit) =>
      limit.asset.chainId === BNB_TESTNET.chainId &&
      limit.asset.kind === "erc20" &&
      limit.asset.address?.toLowerCase() === approved.asset.toLowerCase()
  );
  if (!spendLimit || BigInt(approved.amount) > BigInt(spendLimit.limit)) {
    throw new HunterError(
      403,
      "AUTHORITY_SPEND_EXCEEDED",
      "x402 quote exceeds the active authority token limit"
    );
  }
}

export function validateX402AuthorityRemaining(
  approved: X402Accept,
  spending: AuthoritySpendSummary[],
  reserved = 0n
): void {
  const summary = spending.find(
    (item) =>
      item.asset.chainId === BNB_TESTNET.chainId &&
      item.asset.kind === "erc20" &&
      item.asset.address?.toLowerCase() === approved.asset.toLowerCase()
  );
  if (!summary || BigInt(approved.amount) + reserved > BigInt(summary.remaining)) {
    throw new HunterError(
      403,
      "AUTHORITY_SPEND_EXCEEDED",
      "x402 quote exceeds the active authority remaining token limit",
      {
        requested: approved.amount,
        reserved: reserved.toString(),
        remaining: summary?.remaining ?? "0"
      }
    );
  }
}

function authorityReservationKey(authority: AuthorityRecord, approved: X402Accept): string {
  return `${authority.authorityId}:${approved.asset.toLowerCase()}:day`;
}

async function reserveAuthoritySpend(
  authority: AuthorityRecord,
  approved: X402Accept
): Promise<() => void> {
  const key = authorityReservationKey(authority, approved);
  const spending = await readAuthoritySpending({
    authority,
    rpcUrl: hunterConfig.rpcUrl,
    receiptStorePaths: hunterConfig.altana.paymentEvidencePaths
  });
  const reserved = authoritySpendReservations.get(key) ?? 0n;
  validateX402AuthorityRemaining(approved, spending, reserved);
  const amount = BigInt(approved.amount);
  authoritySpendReservations.set(key, reserved + amount);
  return () => {
    const current = authoritySpendReservations.get(key) ?? 0n;
    const next = current > amount ? current - amount : 0n;
    if (next === 0n) {
      authoritySpendReservations.delete(key);
    } else {
      authoritySpendReservations.set(key, next);
    }
  };
}

function serviceMaxAmount(service: ServiceInfo): Money {
  if (!service.asset || service.asset.kind !== "erc20" || !service.asset.address) {
    throw new HunterError(422, "X402_ASSET_REQUIRED", "x402 service must advertise an ERC-20 asset");
  }
  if (!/^\d+$/.test(service.price)) {
    throw new HunterError(422, "X402_PRICE_INVALID", "x402 service price must be an integer amount");
  }
  return { asset: service.asset, amount: service.price };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HunterError(502, "X402_RESPONSE_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HunterError(502, "X402_RESPONSE_INVALID", `${label} did not return valid JSON`);
  }
}

function parseExecution(
  value: unknown,
  input: {
    request: X402ExecutionRequest;
    service: ServiceInfo;
    selectedAccept: X402Accept;
  }
): X402ExecuteSuccessResponse {
  const body = requireObject(value, "x402 execution response");
  const receipt = requireObject(body.receipt, "receipt");
  const payment = requireObject(body.payment, "payment");
  const amount = requireObject(payment.amount, "payment.amount");
  const asset = requireObject(amount.asset, "payment.amount.asset");
  const transaction = payment.transaction;

  if (typeof body.result !== "string" || !body.result.trim()) {
    throw new HunterError(502, "X402_RESPONSE_INVALID", "x402 execution result is empty");
  }
  if (body.requestHash !== input.request.requestHash || receipt.requestHash !== input.request.requestHash) {
    throw new HunterError(502, "X402_RESPONSE_MISMATCH", "x402 response does not match requestHash");
  }
  if (body.idempotencyKey !== input.request.idempotencyKey) {
    throw new HunterError(502, "X402_RESPONSE_MISMATCH", "x402 response does not match idempotencyKey");
  }
  if (payment.status !== "payment-completed" || payment.rail !== "x402") {
    throw new HunterError(502, "X402_PAYMENT_INVALID", "x402 payment is not completed");
  }
  if (typeof transaction !== "string" || !HEX_HASH.test(transaction)) {
    throw new HunterError(502, "X402_PAYMENT_INVALID", "x402 settlement transaction is invalid");
  }
  if (payment.network !== input.selectedAccept.network) {
    throw new HunterError(502, "X402_PAYMENT_MISMATCH", "x402 settlement network changed");
  }
  if (typeof payment.recipient !== "string" || !sameAddress(payment.recipient, input.service.provider)) {
    throw new HunterError(502, "X402_PAYMENT_MISMATCH", "x402 settlement recipient changed");
  }
  if (typeof amount.amount !== "string" || amount.amount !== input.selectedAccept.amount) {
    throw new HunterError(502, "X402_PAYMENT_MISMATCH", "x402 settlement amount changed");
  }
  const settledAsset = {
    chainId: asset.chainId,
    kind: asset.kind,
    address: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals
  };
  if (!input.service.asset || !sameAsset(settledAsset as Money["asset"], input.service.asset)) {
    throw new HunterError(502, "X402_PAYMENT_MISMATCH", "x402 settlement asset changed");
  }
  if (typeof receipt.provider !== "string" || !sameAddress(receipt.provider, input.service.provider)) {
    throw new HunterError(502, "X402_RESPONSE_MISMATCH", "service receipt provider changed");
  }

  return value as X402ExecuteSuccessResponse;
}

export function buildX402PurchaseRequest(input: X402PurchaseInput, now: number): {
  request: X402ExecutionRequest;
  resourceUrl: string;
  maxAmount: Money;
} {
  if (!input.service.paymentRails?.includes("x402")) {
    throw new HunterError(422, "X402_NOT_ADVERTISED", "service does not advertise x402");
  }
  if (input.service.network !== `eip155:${BNB_TESTNET.chainId}`) {
    throw new HunterError(422, "X402_NETWORK_UNSUPPORTED", "Altana x402 currently requires BNB Testnet");
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("x402 request timestamp must be a positive safe integer");
  }
  const offerVersion = input.service.offerVersion ?? "1";
  const maxAmount = serviceMaxAmount(input.service);
  const expiresAt = now + 60;
  const paymentNonce = `0x${randomBytes(32).toString("hex")}` as HexHash;
  const requestHash = calculateX402RequestHash({
    missionId: input.missionId,
    chainId: BNB_TESTNET.chainId,
    serviceId: input.service.id,
    offerVersion,
    taskType: input.taskType,
    taskInput: input.taskInput,
    timestamp: now,
    expiresAt,
    paymentNonce,
    assetAddress: maxAmount.asset.address!,
    amount: maxAmount.amount,
    providerAddress: input.service.provider,
    resourcePath: "/execute/x402"
  });
  const idempotencyKey = calculateX402IdempotencyKey({
    missionId: input.missionId,
    serviceId: input.service.id,
    requestHash
  });
  const request: X402ExecutionRequest = {
    missionId: input.missionId,
    serviceId: input.service.id,
    offerVersion,
    taskType: input.taskType,
    taskInput: input.taskInput,
    timestamp: now,
    expiresAt,
    paymentNonce,
    asset: maxAmount.asset.address!,
    amount: maxAmount.amount,
    requestHash,
    idempotencyKey,
    ...(input.locale ? { locale: input.locale } : {})
  };
  return {
    request,
    resourceUrl: buildX402ResourceUrl(input.service.endpoint, requestHash),
    maxAmount
  };
}

export async function purchaseServiceWithX402(
  input: X402PurchaseInput,
  deps: X402ClientDependencies
): Promise<X402PurchaseResult> {
  const key = purchaseKey(input.missionId, input.service.id);
  const existing = await deps.purchaseStore?.get(key);
  if (existing) return resumeJournalledPurchase(input, deps, existing);
  const built = buildX402PurchaseRequest(input, deps.now());
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": built.request.idempotencyKey
    },
    body: JSON.stringify(built.request)
  };
  const quoteResponse = await deps.quoteFetch(built.resourceUrl, init);
  if (quoteResponse.status !== 402) {
    const failure = await readJson(quoteResponse, "x402 quote failure").catch(() => undefined);
    const detail = failure && typeof failure === "object"
      ? [
          "code" in failure && typeof failure.code === "string" ? failure.code : undefined,
          "message" in failure && typeof failure.message === "string" ? failure.message : undefined,
          "details" in failure && typeof failure.details === "string" ? failure.details : undefined
        ].filter(Boolean).join(": ")
      : undefined;
    throw new HunterError(
      502,
      "X402_CHALLENGE_EXPECTED",
      `x402 quote request returned ${quoteResponse.status}, expected 402${detail ? `: ${detail}` : ""}`
    );
  }
  const requirement = parseX402PaymentRequirement(await readJson(quoteResponse, "x402 quote"));
  let selectedAccept: X402Accept;
  try {
    selectedAccept = selectX402Accept(requirement, {
      expectedResourceUrl: built.resourceUrl,
      recipient: input.service.provider,
      maxAmount: built.maxAmount,
      preferRail: hunterConfig.x402.preferRail,
      maxTimeoutSeconds: 480
    });
  } catch (error) {
    throw new HunterError(403, "X402_POLICY_REJECTED", error instanceof Error ? error.message : String(error));
  }
  input.onRequirement?.({ requirement, selectedAccept, request: built.request });

  if (deps.purchaseStore && !await deps.purchaseStore.create(key, {
    service: input.service, request: built.request, requirement, selectedAccept
  })) {
    const winner = await deps.purchaseStore.get(key);
    if (!winner) throw new HunterError(503, "X402_JOURNAL_UNAVAILABLE", "Purchase journal is unavailable; no payment submitted");
    return resumeJournalledPurchase(input, deps, winner);
  }

  const paidResponse = await deps.paidFetch(built.resourceUrl, init, selectedAccept);
  if (!paidResponse.ok) {
    const failure = await readJson(paidResponse, "x402 paid request").catch(() => undefined);
    const failureSummary = failure && typeof failure === "object"
      ? [
          "code" in failure && typeof failure.code === "string" ? failure.code : undefined,
          "message" in failure && typeof failure.message === "string" ? failure.message : undefined,
          "details" in failure && typeof failure.details === "string" ? failure.details : undefined
        ].filter(Boolean).join(": ")
      : undefined;
    throw new HunterError(
      paidResponse.status === 402 ? 402 : 502,
      paidResponse.status === 402 ? "X402_PAYMENT_REQUIRED" : "X402_EXECUTION_FAILED",
      `x402 paid request returned ${paidResponse.status}${failureSummary ? `: ${failureSummary}` : ""}`,
      failure
    );
  }
  const execution = parseExecution(await readJson(paidResponse, "x402 paid request"), {
    request: built.request,
    service: input.service,
    selectedAccept
  });
  return { requirement, selectedAccept, execution, request: built.request };
}

async function resumeJournalledPurchase(
  input: X402PurchaseInput, deps: X402ClientDependencies, saved: StoredX402Purchase
): Promise<X402PurchaseResult> {
  if (saved.request.taskType !== input.taskType || saved.request.taskInput !== input.taskInput ||
      saved.request.missionId !== input.missionId || saved.request.serviceId !== input.service.id ||
      !sameAddress(saved.service.provider, input.service.provider)) {
    throw new HunterError(409, "X402_PURCHASE_CONFLICT", "Mission/service already has a different purchase; original payment intent was retained");
  }
  input.onRequirement?.({ requirement: saved.requirement, selectedAccept: saved.selectedAccept, request: saved.request });
  // Unsigned replay only, including after restarts and quote expiry. Never authorize another debit here.
  const response = await deps.quoteFetch(buildX402ResourceUrl(input.service.endpoint, saved.request.requestHash), {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": saved.request.idempotencyKey },
    body: JSON.stringify(saved.request)
  });
  if (!response.ok) {
    throw new HunterError(409, "X402_SETTLEMENT_UNCERTAIN", "Original purchase is not ready. Reconcile its requestHash before another payment.", {
      requestHash: saved.request.requestHash, idempotencyKey: saved.request.idempotencyKey, status: response.status
    });
  }
  const execution = parseExecution(await readJson(response, "x402 original purchase"), {
    request: saved.request, service: saved.service, selectedAccept: saved.selectedAccept
  });
  return { request: saved.request, requirement: saved.requirement, selectedAccept: saved.selectedAccept, execution };
}

export async function createProductionX402Dependencies(): Promise<X402ClientDependencies> {
  if (!hunterConfig.x402.enabled || !hunterConfig.altana.enabled) {
    throw new HunterError(503, "X402_NOT_CONFIGURED", "x402 and Altana must both be enabled");
  }
  if (hunterConfig.chainId !== BNB_TESTNET.chainId) {
    throw new HunterError(422, "X402_NETWORK_UNSUPPORTED", "Altana x402 currently requires BNB Testnet");
  }
  const authorityId = browserAuthorityContext.getStore()?.authorityId ?? hunterConfig.altana.authorityId;
  const encryptionKey = hunterConfig.altana.sessionEncryptionKey;
  if (!authorityId || !encryptionKey) {
    throw new HunterError(
      503,
      "ALTANA_AUTHORITY_NOT_CONFIGURED",
      "ALTANA_AUTHORITY_ID and ALTANA_SESSION_ENCRYPTION_KEY are required"
    );
  }
  const postgres = await getProcessPostgresStore("agora-hunter");
  return {
    purchaseStore: postgres
      ? new PostgresX402PurchaseStore(postgres)
      : new FileX402PurchaseStore(hunterConfig.x402.purchaseStorePath),
    now: () => Math.floor(Date.now() / 1000),
    quoteFetch: (url, init) => fetch(url, init),
    paidFetch: async (url, init, approved) => {
      let record;
      try {
        record = await loadActiveAltanaAuthority({
          authorityId,
          storePath: hunterConfig.altana.sessionStorePath,
          evidencePath: hunterConfig.altana.authorityEvidencePath,
          encryptionKey
        });
      } catch (error) {
        if (error instanceof HunterError) {
          throw error;
        }
        throw new HunterError(
          503,
          "ALTANA_AUTHORITY_LOAD_FAILED",
          "Failed to load the active Altana authority",
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
      validateX402AuthorityPolicy(record.authority, approved);
      let releaseReservation: (() => void) | undefined;
      try {
        releaseReservation = await reserveAuthoritySpend(record.authority, approved);
      } catch (error) {
        if (error instanceof HunterError) throw error;
        throw new HunterError(
          503,
          "AUTHORITY_SPENDING_UNAVAILABLE",
          "Failed to verify the active Authority remaining spend before signing",
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
      let header: string;
      try {
        ensureWebCrypto();
        const request = JSON.parse(String(init.body)) as X402ExecutionRequest;
        if (!HEX_HASH.test(request.requestHash) || request.expiresAt <= Math.floor(Date.now() / 1000)) {
          throw new Error("Original payment request has expired or is invalid");
        }
        ({ header } = await signX402Payment(restoreAltanaSession(record), {
          ...approved,
          maxTimeoutSeconds: request.expiresAt - request.timestamp,
          x402Version: 2,
          resource: { url, mimeType: "application/json" }
        }, {
          now: request.timestamp, permit2Nonce: BigInt(request.requestHash), eip3009Nonce: request.requestHash
        }));
      } catch (error) {
        releaseReservation();
        throw new HunterError(
          503,
          "ALTANA_PAYMENT_SIGN_FAILED",
          "Failed to sign the approved x402 payment with the Altana session",
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
      const headers = new Headers(init.headers);
      headers.set("X-PAYMENT", header);
      headers.set("PAYMENT-SIGNATURE", header);
      const signedInit: RequestInit = { ...init, headers };
      try {
        return await deliverSignedX402WithRetry({
          url,
          init: signedInit,
          attempts: hunterConfig.x402.deliveryAttempts
        });
      } catch (error) {
        throw new HunterError(
          502,
          "X402_SERVICE_UNREACHABLE",
          "Failed to deliver the signed x402 request to the selected service",
          {
            attempts: hunterConfig.x402.deliveryAttempts,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      } finally {
        releaseReservation();
      }
    }
  };
}

export async function runProductionX402Purchase(input: X402PurchaseInput): Promise<X402PurchaseResult> {
  return purchaseServiceWithX402(input, await createProductionX402Dependencies());
}
