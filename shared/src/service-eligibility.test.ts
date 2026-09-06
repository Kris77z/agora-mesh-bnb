import assert from "node:assert/strict";
import test from "node:test";
import { advertisedServices, filterServicesByPaymentMode } from "./service-eligibility.js";
import type { ServiceInfo } from "./types.js";

function offer(id: string): ServiceInfo {
  return { id, name: id, description: "test", endpoint: "http://localhost:3004", provider: "0x1111111111111111111111111111111111111111",
    taskType: "finding-verification", skills: ["solidity"], price: "10", currency: "U", network: "eip155:97", paymentRails: ["x402"],
    asset: { kind: "erc20", chainId: 97, address: "0x2222222222222222222222222222222222222222", symbol: "U", decimals: 18 } };
}
test("discovers both primary and secondary capabilities from one identity", () => {
  const offers = [offer("verifier"), offer("risk-verifier")];
  assert.deepEqual(advertisedServices({ service: offers[0], services: offers }, offers[0].endpoint), offers);
  assert.deepEqual(advertisedServices({ service: offers[0] }, offers[0].endpoint), [offers[0]]);
  assert.deepEqual(advertisedServices({ services: [{ ...offers[0], endpoint: "http://other" }, { price: "malformed" }] }, offers[0].endpoint), []);
});
test("shared selection excludes legacy, wrong-chain, malformed and zero-wallet offers", () => {
  const valid = offer("auditor");
  const candidates = [valid, { ...offer("legacy"), paymentRails: ["legacy-native" as const] },
    { ...offer("wrong-chain"), network: "eip155:56" }, { ...offer("zero"), provider: `0x${"0".repeat(40)}` },
    { ...offer("bad-price"), price: "NaN" },
    { ...offer("offline"), availability: { available: false, reason: "missing runtime" } }];
  assert.deepEqual(filterServicesByPaymentMode(candidates, { x402Enabled: true, chainId: 97 }), [valid]);
});
test("live identity discovery excludes explicitly unavailable capabilities", () => {
  const unavailable = { ...offer("offline"), availability: { available: false, reason: "missing model" } };
  assert.deepEqual(advertisedServices({ services: [unavailable] }, unavailable.endpoint), []);
});
