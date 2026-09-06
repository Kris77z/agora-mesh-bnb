import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInfo } from "@rebel/shared";
import { filterServicesByPaymentMode, isX402CompatibleService } from "./discover.js";

const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    id: "auditor-v1",
    name: "Auditor",
    description: "test",
    endpoint: "http://localhost:3001",
    taskType: "smart-contract-audit",
    price: "500000000000000000",
    currency: "U",
    asset: {
      chainId: 97,
      kind: "erc20",
      address: TOKEN,
      symbol: "U",
      decimals: 18
    },
    network: "eip155:97",
    provider: "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527",
    paymentRails: ["x402"],
    ...overrides
  };
}

test("accepts only complete BNB Testnet ERC-20 x402 offers", () => {
  assert.equal(isX402CompatibleService(service(), 97), true);
  assert.equal(
    isX402CompatibleService(
      service({
        id: "sentinel-audit-v1",
        asset: { chainId: 97, kind: "native", symbol: "tBNB", decimals: 18 }
      }),
      97
    ),
    false
  );
  assert.equal(isX402CompatibleService(service({ paymentRails: ["legacy-native"] }), 97), false);
  assert.equal(isX402CompatibleService(service({ network: "eip155:56" }), 97), false);
});

test("production payment discovery removes a cheaper invalid offer before ranking", () => {
  const validAuditor = service();
  const cheaperInvalidAuditor = service({
    id: "sentinel-audit-v1",
    price: "1",
    asset: { chainId: 97, kind: "native", symbol: "tBNB", decimals: 18 }
  });

  assert.deepEqual(
    filterServicesByPaymentMode([cheaperInvalidAuditor, validAuditor], {
      x402Enabled: true,
      chainId: 97
    }).map((candidate) => candidate.id),
    ["auditor-v1"]
  );
});

test("legacy mode leaves the original service catalog unchanged", () => {
  const services = [service({ id: "legacy", paymentRails: ["legacy-native"] })];
  assert.equal(
    filterServicesByPaymentMode(services, { x402Enabled: false, chainId: 97 }),
    services
  );
});
