import { ethers } from "ethers";
import { assertMoney, sameAsset } from "./money.js";
import type { AssetRef, HexAddress, HexHash, LanguageCode, Money, Receipt } from "./types.js";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_AMOUNT = /^\d+$/;

export type X402TransferMethod = "eip3009" | "permit2-exact";

export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface X402Accept {
  scheme: "exact";
  network: string;
  asset: HexAddress;
  payTo: HexAddress;
  amount: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    assetTransferMethod: X402TransferMethod;
    spenderAddress?: HexAddress;
  };
}

export interface X402PaymentRequirement {
  x402Version: 2;
  error: string;
  resource: X402Resource;
  description?: string;
  accepts: X402Accept[];
}

export interface X402ExecutionRequest {
  missionId: string;
  serviceId: string;
  offerVersion: string;
  taskType: string;
  taskInput: string;
  timestamp: number;
  expiresAt: number;
  paymentNonce: HexHash;
  asset: HexAddress;
  amount: string;
  requestHash: HexHash;
  idempotencyKey: HexHash;
  locale?: LanguageCode;
}

export interface X402PaymentCompleted {
  status: "payment-completed";
  rail: "x402";
  transaction: HexHash;
  network: string;
  payer: HexAddress;
  recipient: HexAddress;
  amount: Money;
  transferMethod: "eip3009" | "permit2" | "permit2-witness";
}

export interface X402ExecuteSuccessResponse {
  result: string;
  receipt: Receipt;
  payment: X402PaymentCompleted;
  requestHash: HexHash;
  idempotencyKey: HexHash;
  cached: boolean;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function requireAddress(value: unknown, label: string): HexAddress {
  if (typeof value !== "string" || !HEX_ADDRESS.test(value)) {
    throw new Error(`${label} must be a 20-byte hex address`);
  }
  return ethers.getAddress(value) as HexAddress;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function calculateX402RequestHash(input: {
  missionId: string;
  chainId: number;
  serviceId: string;
  offerVersion: string;
  taskType: string;
  taskInput: string;
  timestamp: number;
  expiresAt: number;
  paymentNonce: string;
  assetAddress: string;
  amount: string;
  providerAddress: string;
  resourcePath: string;
}): HexHash {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("chainId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0) {
    throw new Error("timestamp must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.timestamp) {
    throw new Error("expiresAt must be after timestamp");
  }
  if (!HEX_HASH.test(input.paymentNonce)) {
    throw new Error("paymentNonce must be a 32-byte hex hash");
  }
  if (!INTEGER_AMOUNT.test(input.amount)) {
    throw new Error("amount must be an integer string");
  }
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "string",
      "uint256",
      "string",
      "string",
      "string",
      "string",
      "uint256",
      "uint256",
      "bytes32",
      "address",
      "uint256",
      "address",
      "string"
    ],
    [
      requireNonEmpty(input.missionId, "missionId"),
      input.chainId,
      requireNonEmpty(input.serviceId, "serviceId"),
      requireNonEmpty(input.offerVersion, "offerVersion"),
      requireNonEmpty(input.taskType, "taskType"),
      input.taskInput,
      input.timestamp,
      input.expiresAt,
      input.paymentNonce,
      requireAddress(input.assetAddress, "assetAddress"),
      input.amount,
      requireAddress(input.providerAddress, "providerAddress"),
      requireNonEmpty(input.resourcePath, "resourcePath")
    ]
  );
  return ethers.keccak256(encoded) as HexHash;
}

export function calculateX402IdempotencyKey(input: {
  missionId: string;
  serviceId: string;
  requestHash: string;
}): HexHash {
  if (!HEX_HASH.test(input.requestHash)) {
    throw new Error("requestHash must be a 32-byte hex hash");
  }
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "bytes32"],
    [
      requireNonEmpty(input.missionId, "missionId"),
      requireNonEmpty(input.serviceId, "serviceId"),
      input.requestHash
    ]
  );
  return ethers.keccak256(encoded) as HexHash;
}

export function buildX402ResourceUrl(serviceEndpoint: string, requestHash: string): string {
  if (!HEX_HASH.test(requestHash)) {
    throw new Error("requestHash must be a 32-byte hex hash");
  }
  const endpoint = new URL(serviceEndpoint);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/execute/x402`.replace(/\/+/g, "/");
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.searchParams.set("requestHash", requestHash);
  return endpoint.toString();
}

export function parseX402PaymentRequirement(value: unknown): X402PaymentRequirement {
  const body = requireRecord(value, "x402 requirement");
  if (body.x402Version !== 2) {
    throw new Error("x402Version must be 2");
  }
  const resource = requireRecord(body.resource, "resource");
  const accepts = Array.isArray(body.accepts) ? body.accepts : [];
  if (accepts.length === 0) {
    throw new Error("x402 requirement must include at least one accept option");
  }

  return {
    x402Version: 2,
    error: requireString(body.error, "error"),
    resource: {
      url: requireString(resource.url, "resource.url"),
      ...(typeof resource.description === "string" ? { description: resource.description } : {}),
      ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {})
    },
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    accepts: accepts.map((raw, index) => {
      const accept = requireRecord(raw, `accepts[${index}]`);
      const extra = requireRecord(accept.extra, `accepts[${index}].extra`);
      const method = extra.assetTransferMethod;
      if (method !== "eip3009" && method !== "permit2-exact") {
        throw new Error(`accepts[${index}].extra.assetTransferMethod is unsupported`);
      }
      if (accept.scheme !== "exact") {
        throw new Error(`accepts[${index}].scheme must be exact`);
      }
      if (typeof accept.amount !== "string" || !INTEGER_AMOUNT.test(accept.amount)) {
        throw new Error(`accepts[${index}].amount must be an integer string`);
      }
      return {
        scheme: "exact",
        network: requireString(accept.network, `accepts[${index}].network`),
        asset: requireAddress(accept.asset, `accepts[${index}].asset`),
        payTo: requireAddress(accept.payTo, `accepts[${index}].payTo`),
        amount: accept.amount,
        maxTimeoutSeconds: requirePositiveInteger(
          accept.maxTimeoutSeconds,
          `accepts[${index}].maxTimeoutSeconds`
        ),
        extra: {
          name: requireString(extra.name, `accepts[${index}].extra.name`),
          version: requireString(extra.version, `accepts[${index}].extra.version`),
          assetTransferMethod: method,
          ...(extra.spenderAddress !== undefined
            ? { spenderAddress: requireAddress(extra.spenderAddress, `accepts[${index}].extra.spenderAddress`) }
            : {})
        }
      };
    })
  };
}

export function selectX402Accept(
  requirement: X402PaymentRequirement,
  policy: {
    expectedResourceUrl: string;
    recipient: string;
    maxAmount: Money;
    preferRail?: "permit2" | "eip3009";
    maxTimeoutSeconds?: number;
  }
): X402Accept {
  assertMoney(policy.maxAmount);
  if (policy.maxAmount.asset.kind !== "erc20" || !policy.maxAmount.asset.address) {
    throw new Error("x402 policy requires an ERC-20 maxAmount asset");
  }
  if (requirement.resource.url !== policy.expectedResourceUrl) {
    throw new Error("x402 resource URL does not match the requested resource");
  }
  const expectedNetwork = `eip155:${policy.maxAmount.asset.chainId}`;
  const matches = requirement.accepts.filter((accept) => {
    const quotedAsset: AssetRef = {
      chainId: policy.maxAmount.asset.chainId,
      kind: "erc20",
      address: accept.asset,
      symbol: policy.maxAmount.asset.symbol,
      decimals: policy.maxAmount.asset.decimals
    };
    return (
      accept.network === expectedNetwork &&
      sameAsset(quotedAsset, policy.maxAmount.asset) &&
      accept.payTo.toLowerCase() === policy.recipient.toLowerCase() &&
      BigInt(accept.amount) <= BigInt(policy.maxAmount.amount) &&
      accept.maxTimeoutSeconds <= (policy.maxTimeoutSeconds ?? 480)
    );
  });
  const preferredMethod = policy.preferRail === "eip3009" ? "eip3009" : "permit2-exact";
  const selected = matches.find((item) => item.extra.assetTransferMethod === preferredMethod) ?? matches[0];
  if (!selected) {
    throw new Error("No x402 quote satisfies the configured payment policy");
  }
  return selected;
}
