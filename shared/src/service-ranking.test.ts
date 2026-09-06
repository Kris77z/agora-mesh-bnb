import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInfo } from "./types.js";
import { rankServiceOffers } from "./service-ranking.js";

function service(overrides: Partial<ServiceInfo> & Pick<ServiceInfo, "id">): ServiceInfo {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    description: "test service",
    endpoint: `http://localhost/${id}`,
    taskType: "smart-contract-audit",
    skills: ["solidity"],
    price: "100",
    currency: "tBNB",
    network: "eip155:97",
    provider: "0x0000000000000000000000000000000000000000",
    ...rest
  };
}

test("ranks offers with one transparent capability, reputation, price, and latency model", () => {
  const ranked = rankServiceOffers(
    [
      service({ id: "slow", price: "100", averageLatencyMs: 30_000 }),
      service({ id: "fast", price: "120", averageLatencyMs: 10_000 })
    ],
    {
      taskType: "smart-contract-audit",
      requiredSkills: ["solidity"],
      reputationScores: new Map([["slow", 60], ["fast", 90]])
    }
  );

  assert.equal(ranked[0].service.id, "fast");
  assert.equal(ranked[0].rank, 1);
  assert.deepEqual(Object.keys(ranked[0].scores), ["capability", "reputation", "price", "latency"]);
  assert.match(ranked[0].reason, /capability match/);
});

test("rejects malformed integer prices instead of ranking them as cheap", () => {
  assert.throws(() => rankServiceOffers([service({ id: "bad", price: "1.5" })]), /Invalid service price/);
});
