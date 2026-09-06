import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInfo } from "@rebel/shared";
import {
  createPhaseSpendApprover,
  filterServicesByTaskType,
  inferTaskTypeFromGoal
} from "./scripted-flow.js";
import { HunterError } from "./errors.js";

function service(id: string, taskType?: string): ServiceInfo {
  return {
    id,
    name: id,
    description: "test",
    endpoint: "http://localhost/test",
    taskType,
    price: "1",
    currency: "tBNB",
    network: "eip155:97",
    provider: `0x${id.length.toString(16).padStart(40, "0")}`
  };
}

test("infers security audits from an address or Solidity source", () => {
  assert.equal(
    inferTaskTypeFromGoal("0x0000000000000000000000000000000000000001"),
    "smart-contract-audit"
  );
  assert.equal(inferTaskTypeFromGoal("contract Vault { }"), "smart-contract-audit");
});

test("routes explicit token and wallet risk goals to the onchain investigator", () => {
  assert.equal(
    inferTaskTypeFromGoal("Investigate token risk for 0x0000000000000000000000000000000000000001"),
    "onchain-investigation"
  );
  assert.equal(
    inferTaskTypeFromGoal("调查这个钱包行为 0x0000000000000000000000000000000000000001"),
    "onchain-investigation"
  );
  assert.deepEqual(
    filterServicesByTaskType(
      [service("writer", "content-generation"), service("investigator", "onchain-investigation")],
      "onchain-investigation"
    ).map((item) => item.id),
    ["investigator"]
  );
  assert.deepEqual(
    filterServicesByTaskType(
      [service("investigator", "onchain-investigation"), service("risk-verifier", "token-risk-verification")],
      "token-risk-verification"
    ).map((item) => item.id),
    ["risk-verifier"]
  );
});

test("never falls back from a security audit to an unrelated generic service", () => {
  assert.deepEqual(
    filterServicesByTaskType(
      [service("writer", "content-generation"), service("legacy-without-type")],
      "smart-contract-audit"
    ),
    []
  );
});

test("rejects Auditor plus Verifier quotes before they exceed the phase budget", () => {
  const nativeAsset = { chainId: 97, kind: "native" as const, symbol: "tBNB", decimals: 18 };
  const approve = createPhaseSpendApprover({ asset: nativeAsset, amount: "10" });
  const auditor = service("auditor", "smart-contract-audit");
  auditor.asset = nativeAsset;
  const verifier = service("verifier", "finding-verification");
  verifier.asset = nativeAsset;
  approve(auditor, "7");
  assert.throws(
    () => approve(verifier, "4"),
    (error: unknown) =>
      error instanceof HunterError && error.code === "COMMANDER_PHASE_BUDGET_EXCEEDED"
  );
});
