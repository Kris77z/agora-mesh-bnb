import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateX402IdempotencyKey,
  calculateX402RequestHash,
  buildX402ResourceUrl,
  parseX402PaymentRequirement,
  selectX402Accept
} from "./payment.js";

const SELLER = "0x0000000000000000000000000000000000000001" as const;
const TOKEN = "0x0000000000000000000000000000000000000002" as const;
const SPENDER = "0x0000000000000000000000000000000000000003" as const;
const resourceUrl = "https://seller.example/execute/x402?requestHash=0xabc";

function requirement() {
  return parseX402PaymentRequirement({
    x402Version: 2,
    error: "payment required",
    resource: { url: resourceUrl },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:97",
        asset: TOKEN,
        payTo: SELLER,
        amount: "20",
        maxTimeoutSeconds: 300,
        extra: {
          name: "United Stables",
          version: "1",
          assetTransferMethod: "eip3009"
        }
      },
      {
        scheme: "exact",
        network: "eip155:97",
        asset: TOKEN,
        payTo: SELLER,
        amount: "20",
        maxTimeoutSeconds: 300,
        extra: {
          name: "United Stables",
          version: "1",
          assetTransferMethod: "permit2-exact",
          spenderAddress: SPENDER
        }
      }
    ]
  });
}

describe("x402 payment model", () => {
  it("hashes all request binding fields deterministically", () => {
    const input = {
      missionId: "mission-a",
      chainId: 97,
      serviceId: "auditor-v1",
      offerVersion: "1",
      taskType: "smart-contract-audit",
      taskInput: "audit 0x1234",
      timestamp: 1_800_000_000,
      expiresAt: 1_800_000_060,
      paymentNonce: `0x${"12".repeat(32)}`,
      assetAddress: TOKEN,
      amount: "20",
      providerAddress: SELLER,
      resourcePath: "/execute/x402"
    };
    const first = calculateX402RequestHash(input);
    assert.equal(first, calculateX402RequestHash(input));
    for (const changed of [
      { ...input, missionId: "mission-b" },
      { ...input, taskInput: "audit 0xabcd" },
      { ...input, expiresAt: input.expiresAt + 1 },
      { ...input, paymentNonce: `0x${"34".repeat(32)}` },
      { ...input, amount: "21" }
    ]) {
      assert.notEqual(first, calculateX402RequestHash(changed));
    }
    assert.match(first, /^0x[0-9a-f]{64}$/);
  });

  it("derives a mission-scoped idempotency key", () => {
    const requestHash = calculateX402RequestHash({
      missionId: "mission-a",
      chainId: 97,
      serviceId: "auditor-v1",
      offerVersion: "1",
      taskType: "smart-contract-audit",
      taskInput: "audit",
      timestamp: 1_800_000_000,
      expiresAt: 1_800_000_060,
      paymentNonce: `0x${"12".repeat(32)}`,
      assetAddress: TOKEN,
      amount: "20",
      providerAddress: SELLER,
      resourcePath: "/execute/x402"
    });
    const first = calculateX402IdempotencyKey({ missionId: "mission-a", serviceId: "auditor-v1", requestHash });
    const second = calculateX402IdempotencyKey({ missionId: "mission-b", serviceId: "auditor-v1", requestHash });
    assert.notEqual(first, second);
  });

  it("builds a canonical request-bound resource URL", () => {
    const requestHash = `0x${"ab".repeat(32)}`;
    assert.equal(
      buildX402ResourceUrl("https://seller.example/", requestHash),
      `https://seller.example/execute/x402?requestHash=${requestHash}`
    );
  });

  it("selects the preferred rail only when every policy field matches", () => {
    const selected = selectX402Accept(requirement(), {
      expectedResourceUrl: resourceUrl,
      recipient: SELLER,
      maxAmount: {
        asset: { chainId: 97, kind: "erc20", address: TOKEN, symbol: "U", decimals: 18 },
        amount: "20"
      },
      preferRail: "permit2"
    });
    assert.equal(selected.extra.assetTransferMethod, "permit2-exact");
  });

  it("rejects wrong resource, recipient, asset, amount, and timeout", () => {
    const base = {
      expectedResourceUrl: resourceUrl,
      recipient: SELLER,
      maxAmount: {
        asset: { chainId: 97, kind: "erc20" as const, address: TOKEN, symbol: "U", decimals: 18 },
        amount: "20"
      }
    };
    assert.throws(() => selectX402Accept(requirement(), { ...base, expectedResourceUrl: "https://evil.example" }));
    assert.throws(() => selectX402Accept(requirement(), { ...base, recipient: SPENDER }));
    assert.throws(() => selectX402Accept(requirement(), {
      ...base,
      maxAmount: { ...base.maxAmount, amount: "19" }
    }));
    assert.throws(() => selectX402Accept(requirement(), { ...base, maxTimeoutSeconds: 299 }));
  });

  it("rejects malformed wire responses", () => {
    assert.throws(() => parseX402PaymentRequirement({ x402Version: 1, accepts: [] }));
    assert.throws(() => parseX402PaymentRequirement({
      x402Version: 2,
      error: "payment required",
      resource: { url: resourceUrl },
      accepts: [{ scheme: "exact", amount: "1.5" }]
    }));
  });
});
