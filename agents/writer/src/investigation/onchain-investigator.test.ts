import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  createInvestigationRpc,
  investigateOnchainTarget,
  readRuntimeOpcodes,
  type InvestigationRpc
} from "./onchain-investigator.js";

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

function contractRpc(): InvestigationRpc {
  const mintSelector = ethers.id("mint(address,uint256)").slice(2, 10);
  const code = `0x63${mintSelector}6000f4`;
  return {
    endpoint: "https://rpc.example",
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === "eth_blockNumber") return "0x64" as T;
      if (method === "eth_getBalance") return "0x2a" as T;
      if (method === "eth_getTransactionCount") return "0x7" as T;
      if (method === "eth_getCode") return code as T;
      if (method === "eth_getStorageAt") {
        const slot = params[1];
        const address = String(slot).startsWith("0x3608") ? IMPLEMENTATION : ADMIN;
        return ethers.zeroPadValue(address, 32) as T;
      }
      if (method === "eth_call") {
        const request = params[0] as { data: string };
        const selector = request.data.slice(0, 10);
        const outputs: Array<[string, unknown]> = [
          ["name", "Risk Token"],
          ["symbol", "RISK"],
          ["decimals", 18],
          ["totalSupply", 1_000_000n],
          ["owner", OWNER]
        ];
        const match = outputs.find(([name]) => ABI.getFunction(name)?.selector === selector);
        if (!match) throw new Error("unsupported call");
        return ABI.encodeFunctionResult(match[0], [match[1]]) as T;
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };
}

test("builds a source-timestamped ERC-20 risk report from deterministic RPC facts", async () => {
  const report = await investigateOnchainTarget(
    JSON.stringify({ address: TARGET, chainId: 97 }),
    {
      chainId: 97,
      now: () => new Date("2026-09-01T07:00:00.000Z"),
      rpc: contractRpc()
    }
  );

  assert.equal(report.target.classification, "erc20");
  assert.equal(report.target.bytecodeSize, 8);
  assert.equal(report.facts.token?.symbol, "RISK");
  assert.equal(report.facts.token?.totalSupply, "1000000");
  assert.equal(report.facts.ownership.owner, ethers.getAddress(OWNER));
  assert.equal(report.facts.proxy.implementation, ethers.getAddress(IMPLEMENTATION));
  assert.equal(report.facts.proxy.admin, ethers.getAddress(ADMIN));
  assert.equal(report.riskLevel, "high");
  assert.deepEqual(
    report.riskSignals.map((item) => item.id),
    [
      "privileged-owner",
      "eip1967-upgradeability",
      "bytecode-capability-mint",
      "runtime-delegatecall"
    ]
  );
  assert.equal(report.coverage.holderConcentration, "not-measured");
  assert.equal(report.coverage.liquidity, "not-measured");
  assert.equal(report.sources[0]?.observedAt, report.observedAt);
});

test("reports an EOA without making contract metadata claims", async () => {
  const rpc: InvestigationRpc = {
    endpoint: "https://rpc.example",
    async call<T>(method: string): Promise<T> {
      if (method === "eth_blockNumber") return "0x1" as T;
      if (method === "eth_getBalance") return "0x0" as T;
      if (method === "eth_getTransactionCount") return "0x2" as T;
      if (method === "eth_getCode") return "0x" as T;
      throw new Error(`Contract read should not run for EOA: ${method}`);
    }
  };
  const report = await investigateOnchainTarget(TARGET, {
    chainId: 97,
    now: () => new Date("2026-09-01T07:00:00.000Z"),
    rpc
  });
  assert.equal(report.target.classification, "eoa");
  assert.equal(report.facts.token, undefined);
  assert.equal(report.facts.ownership.probe, "unavailable");
  assert.equal(report.riskScore, 0);
  assert.equal(report.riskLevel, "low");
});

test("rejects malformed addresses and cross-chain investigation requests", async () => {
  const deps = {
    chainId: 97,
    now: () => new Date(),
    rpc: contractRpc()
  };
  await assert.rejects(() => investigateOnchainTarget("not-an-address", deps), /requires an EVM address/);
  await assert.rejects(
    () => investigateOnchainTarget(JSON.stringify({ address: TARGET, chainId: 56 }), deps),
    /does not match service chain/
  );
});

test("opcode scan skips bytes embedded inside PUSH data", () => {
  const opcodes = readRuntimeOpcodes("0x60ff6000f4");
  assert.equal(opcodes.has(0xff), false);
  assert.equal(opcodes.has(0xf4), true);
});

test("production RPC transport retries reads and rejects state-changing methods", async () => {
  let calls = 0;
  const rpc = createInvestigationRpc({
    endpoint: "https://rpc.example/secret-path",
    timeoutMs: 1_000,
    attempts: 2,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x1" });
    }
  });
  assert.equal(rpc.endpoint, "https://rpc.example");
  assert.equal(await rpc.call("eth_blockNumber", []), "0x1");
  assert.equal(calls, 2);
  await assert.rejects(
    () => rpc.call("eth_sendRawTransaction", ["0xdeadbeef"]),
    /not read-only or allowlisted/
  );
  assert.equal(calls, 2);
});
