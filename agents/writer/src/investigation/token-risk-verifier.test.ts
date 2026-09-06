import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  investigateOnchainTarget,
  type InvestigationRpc
} from "./onchain-investigator.js";
import { verifyTokenRiskReport } from "./token-risk-verifier.js";

const TARGET = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const IMPLEMENTATION = "0x3333333333333333333333333333333333333333";
const ADMIN = "0x4444444444444444444444444444444444444444";
const ABI = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)"
]);

function replayRpc(endpoint: string, observedTags: string[] = []): InvestigationRpc {
  const mintSelector = ethers.id("mint(address,uint256)").slice(2, 10);
  const proxyCode = `0x63${mintSelector}6000f4`;
  const implementationCode = `0x63${mintSelector}600000`;
  return {
    endpoint,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const maybeTag = params.at(-1);
      if (typeof maybeTag === "string" && (maybeTag === "latest" || maybeTag.startsWith("0x"))) {
        observedTags.push(maybeTag);
      }
      if (method === "eth_blockNumber") return "0x64" as T;
      if (method === "eth_getBalance") return "0x2a" as T;
      if (method === "eth_getTransactionCount") return "0x7" as T;
      if (method === "eth_getCode") {
        return (String(params[0]).toLowerCase() === IMPLEMENTATION.toLowerCase()
          ? implementationCode
          : proxyCode) as T;
      }
      if (method === "eth_getStorageAt") {
        const slot = params[1];
        const address = String(slot).startsWith("0x3608") ? IMPLEMENTATION : ADMIN;
        return ethers.zeroPadValue(address, 32) as T;
      }
      if (method === "eth_call") {
        const request = params[0] as { data: string };
        const outputs: Array<[string, unknown]> = [
          ["name", "Risk Token"],
          ["symbol", "RISK"],
          ["decimals", 18],
          ["totalSupply", 1_000_000n],
          ["owner", OWNER]
        ];
        const match = outputs.find(([name]) => ABI.getFunction(name)?.selector === request.data.slice(0, 10));
        if (!match) throw new Error("unsupported call");
        return ABI.encodeFunctionResult(match[0], [match[1]]) as T;
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };
}

test("independently replays every deterministic risk dimension at the source block", async () => {
  const source = await investigateOnchainTarget(TARGET, {
    chainId: 97,
    rpc: replayRpc("https://source-rpc.example"),
    now: () => new Date("2026-09-01T07:00:00.000Z"),
    blockNumber: 100
  });
  const observedTags: string[] = [];
  const verification = await verifyTokenRiskReport(JSON.stringify({ report: source }), {
    chainId: 97,
    rpc: replayRpc("https://independent-rpc.example", observedTags),
    now: () => new Date("2026-09-01T08:00:00.000Z")
  });

  assert.equal(verification.engine.independentTransport, true);
  assert.equal(verification.conclusion.status, "confirmed");
  assert.equal(verification.summary.confirmed, verification.summary.total);
  assert.equal(verification.summary.mismatched, 0);
  assert.equal(verification.summary.total, 11);
  assert.ok(observedTags.length > 0);
  assert.ok(observedTags.every((tag) => tag === "0x64"));
});

test("rejects a report when replayed scoring does not match", async () => {
  const source = await investigateOnchainTarget(TARGET, {
    chainId: 97,
    rpc: replayRpc("https://source-rpc.example"),
    now: () => new Date("2026-09-01T07:00:00.000Z"),
    blockNumber: 100
  });
  const verification = await verifyTokenRiskReport(JSON.stringify({
    report: { ...source, riskScore: source.riskScore + 1 }
  }), {
    chainId: 97,
    rpc: replayRpc("https://independent-rpc.example"),
    now: () => new Date("2026-09-01T08:00:00.000Z")
  });

  assert.equal(verification.conclusion.status, "rejected");
  assert.equal(
    verification.checks.find((check) => check.id === "risk-score")?.status,
    "mismatch"
  );
});
