import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInfo } from "./types.js";
import {
  isServiceRankingPreference,
  rankServiceOffers,
  resolveServiceRankingPreference,
  SERVICE_RANKING_PREFERENCES
} from "./service-ranking.js";

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

test("named ranking preferences reweight the same model and can flip the winner", () => {
  const candidates = [
    service({ id: "cheap-fast-unproven", price: "400", averageLatencyMs: 45_000 }),
    service({ id: "pricier-proven", price: "500", averageLatencyMs: 90_000 })
  ];
  const context = {
    taskType: "smart-contract-audit",
    requiredSkills: ["solidity"],
    reputationScores: new Map([["cheap-fast-unproven", 0], ["pricier-proven", 83]])
  };

  const balanced = rankServiceOffers(candidates, {
    ...context,
    weights: resolveServiceRankingPreference("balanced")
  });
  assert.equal(balanced[0].service.id, "cheap-fast-unproven");

  const reputationFirst = rankServiceOffers(candidates, {
    ...context,
    weights: resolveServiceRankingPreference("reputation-first")
  });
  assert.equal(reputationFirst[0].service.id, "pricier-proven");

  const priceFirst = rankServiceOffers(candidates, {
    ...context,
    weights: resolveServiceRankingPreference("price-first")
  });
  assert.equal(priceFirst[0].service.id, "cheap-fast-unproven");
});

test("preference guard accepts only defined presets and defaults to balanced", () => {
  assert.equal(isServiceRankingPreference("reputation-first"), true);
  assert.equal(isServiceRankingPreference("cheapest"), false);
  assert.equal(isServiceRankingPreference(42), false);
  assert.deepEqual(resolveServiceRankingPreference(), SERVICE_RANKING_PREFERENCES.balanced);
});
