import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { OnchainRiskReport } from "@rebel/shared";
import type { InvestigationRpc } from "./onchain-investigator.js";
import {
  enrichTokenRiskWithPancakeLiquidity,
  summarizeErc20TransferWindow
} from "./token-risk-enrichment.js";

const TARGET = "0x1111111111111111111111111111111111111111";
const WBNB = "0x2222222222222222222222222222222222222222";
const PAIR = "0x3333333333333333333333333333333333333333";
const V3_POOL = "0x4444444444444444444444444444444444444444";
const router = new ethers.Interface([
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])"
]);
const factoryV2 = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const pairV2 = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)"
]);
const factoryV3 = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const poolV3 = new ethers.Interface([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"
]);

function sourceReport(): OnchainRiskReport {
  return {
    version: 1,
    chainId: 97,
    target: {
      address: TARGET,
      classification: "erc20",
      bytecodeSize: 1,
      bytecodeHash: `0x${"11".repeat(32)}`
    },
    observedAt: "2026-09-01T00:00:00.000Z",
    blockNumber: 123,
    sources: [],
    facts: {
      nativeBalanceWei: "0",
      transactionCount: "1",
      token: { decimals: 18, totalSupply: "1000000000000000000000" },
      ownership: { probe: "unavailable" },
      proxy: { standard: "eip-1967" }
    },
    riskSignals: [],
    riskScore: 0,
    riskLevel: "low",
    coverage: {
      accountState: "measured",
      contractBytecode: "measured",
      tokenMetadata: "measured",
      ownership: "unavailable",
      proxySlots: "measured",
      holderConcentration: "not-measured",
      liquidity: "not-measured",
      recentTransactions: "not-measured"
    },
    limitations: [],
    recommendation: "test"
  };
}

function dexRpc(): InvestigationRpc {
  return {
    endpoint: "https://independent.example",
    async call<T>(method: string, params: unknown[]): Promise<T> {
      assert.equal(method, "eth_call");
      assert.equal(params[1], "0x7b");
      const request = params[0] as { to: string; data: string };
      const selector = request.data.slice(0, 10);
      if (selector === router.getFunction("WETH")!.selector) {
        return router.encodeFunctionResult("WETH", [WBNB]) as T;
      }
      if (selector === factoryV2.getFunction("getPair")!.selector) {
        return factoryV2.encodeFunctionResult("getPair", [PAIR]) as T;
      }
      if (request.to.toLowerCase() === PAIR.toLowerCase()) {
        if (selector === pairV2.getFunction("token0")!.selector) {
          return pairV2.encodeFunctionResult("token0", [WBNB]) as T;
        }
        if (selector === pairV2.getFunction("token1")!.selector) {
          return pairV2.encodeFunctionResult("token1", [TARGET]) as T;
        }
        if (selector === pairV2.getFunction("getReserves")!.selector) {
          return pairV2.encodeFunctionResult("getReserves", [5n, 20n, 1]) as T;
        }
        if (selector === pairV2.getFunction("totalSupply")!.selector) {
          return pairV2.encodeFunctionResult("totalSupply", [10n]) as T;
        }
      }
      if (selector === factoryV3.getFunction("getPool")!.selector) {
        const [, , fee] = factoryV3.decodeFunctionData("getPool", request.data);
        return factoryV3.encodeFunctionResult("getPool", [fee === 500n ? V3_POOL : ethers.ZeroAddress]) as T;
      }
      if (request.to.toLowerCase() === V3_POOL.toLowerCase()) {
        if (selector === poolV3.getFunction("liquidity")!.selector) {
          return poolV3.encodeFunctionResult("liquidity", [0n]) as T;
        }
        if (selector === poolV3.getFunction("slot0")!.selector) {
          return poolV3.encodeFunctionResult("slot0", [100n, 2, 0, 0, 0, 0, true]) as T;
        }
      }
      if (selector === router.getFunction("getAmountsOut")!.selector) {
        return router.encodeFunctionResult("getAmountsOut", [
          [1_000_000_000_000_000_000n, 123n]
        ]) as T;
      }
      throw new Error(`Unsupported call ${request.to} ${selector}`);
    }
  };
}

test("binds PancakeSwap liquidity and quote-only evidence to the source report block", async () => {
  const enrichment = await enrichTokenRiskWithPancakeLiquidity(sourceReport(), {
    rpc: dexRpc(),
    now: () => new Date("2026-09-01T01:00:00.000Z")
  });

  assert.equal(enrichment.blockNumber, 123);
  assert.equal(enrichment.wrappedNative, ethers.getAddress(WBNB));
  assert.equal(enrichment.v2.pair, ethers.getAddress(PAIR));
  assert.equal(enrichment.v2.reserveTokenRaw, "20");
  assert.equal(enrichment.v2.reserveWrappedNativeRaw, "5");
  assert.equal(enrichment.v3.pools.filter((pool) => pool.exists).length, 1);
  assert.equal(enrichment.v3.pools.find((pool) => pool.exists)?.liquidityRaw, "0");
  assert.equal(enrichment.quote.status, "quote-only");
  assert.equal(enrichment.quote.outputWrappedNativeRaw, "123");
  assert.deepEqual(enrichment.coverage, { liquidity: "measured", sellability: "partial" });
});

test("rejects non-testnet and non-ERC20 source reports", async () => {
  await assert.rejects(
    () => enrichTokenRiskWithPancakeLiquidity({ ...sourceReport(), chainId: 56 }, {
      rpc: dexRpc(),
      now: () => new Date()
    }),
    /chain 97/
  );
  await assert.rejects(
    () => enrichTokenRiskWithPancakeLiquidity({
      ...sourceReport(),
      target: { ...sourceReport().target, classification: "contract" }
    }, {
      rpc: dexRpc(),
      now: () => new Date()
    }),
    /ERC-20/
  );
});

test("summarizes a bounded Transfer window without treating mint and burn as holders", () => {
  const topic = (address: string) => ethers.zeroPadValue(address, 32);
  const summary = summarizeErc20TransferWindow([
    {
      blockNumber: "0x64",
      transactionHash: `0x${"11".repeat(32)}`,
      topics: [ethers.id("Transfer(address,address,uint256)"), topic(ethers.ZeroAddress), topic(TARGET)],
      data: ethers.zeroPadValue("0x05", 32)
    },
    {
      blockNumber: "0x65",
      transactionHash: `0x${"22".repeat(32)}`,
      topics: [ethers.id("Transfer(address,address,uint256)"), topic(TARGET), topic(WBNB)],
      data: ethers.zeroPadValue("0x03", 32)
    },
    {
      blockNumber: "0x66",
      transactionHash: `0x${"22".repeat(32)}`,
      topics: [ethers.id("Transfer(address,address,uint256)"), topic(WBNB), topic(ethers.ZeroAddress)],
      data: ethers.zeroPadValue("0x01", 32)
    }
  ]);

  assert.deepEqual(summary, {
    transfers: 3,
    uniqueTransactions: 2,
    mints: 1,
    burns: 1,
    uniqueSenders: 2,
    uniqueRecipients: 2,
    transferredRaw: "9",
    firstBlock: 100,
    lastBlock: 102
  });
});
