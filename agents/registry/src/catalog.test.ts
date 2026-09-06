import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInfo } from "@rebel/shared";
import { filterServiceCatalog, mergeServiceCatalog } from "./catalog.js";

function service(id: string, overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    id,
    name: id,
    description: "test",
    endpoint: `http://localhost/${id}`,
    taskType: "smart-contract-audit",
    skills: ["solidity"],
    price: "100",
    currency: "tBNB",
    asset: { chainId: 97, kind: "native", symbol: "tBNB", decimals: 18 },
    paymentRails: ["legacy-native"],
    network: "eip155:97",
    provider: "0x0000000000000000000000000000000000000000",
    ...overrides
  };
}

test("dynamic advertisements override live fields while retaining seed metadata", () => {
  const merged = mergeServiceCatalog(
    [service("auditor", { averageLatencyMs: 1000, skills: ["solidity", "security"] })],
    [service("auditor", { endpoint: "http://localhost:4001", skills: undefined })]
  );
  assert.equal(merged[0].endpoint, "http://localhost:4001");
  assert.deepEqual(merged[0].skills, ["solidity", "security"]);
  assert.equal(merged[0].averageLatencyMs, 1000);
});

test("filters the catalog by category, payment rail, and chain", () => {
  const services = [
    service("auditor"),
    service("writer", { taskType: "content-generation", skills: ["article"] })
  ];
  assert.deepEqual(
    filterServiceCatalog(services, { category: "solidity", rail: "legacy-native", chainId: 97 })
      .map((item) => item.id),
    ["auditor"]
  );
});
