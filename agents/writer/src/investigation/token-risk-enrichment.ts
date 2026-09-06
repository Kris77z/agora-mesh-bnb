import { ethers } from "ethers";
import type { HexAddress, OnchainRiskReport } from "@rebel/shared";
import type { InvestigationRpc } from "./onchain-investigator.js";

const PANCAKE_TESTNET = {
  routerV2: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  factoryV2: "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
  factoryV3: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"
} as const;
const V3_FEE_TIERS = [100, 500, 2500, 10_000] as const;

const ROUTER_V2_INTERFACE = new ethers.Interface([
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])"
]);
const FACTORY_V2_INTERFACE = new ethers.Interface([
  "function getPair(address,address) view returns (address)"
]);
const PAIR_V2_INTERFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)"
]);
const FACTORY_V3_INTERFACE = new ethers.Interface([
  "function getPool(address,address,uint24) view returns (address)"
]);
const POOL_V3_INTERFACE = new ethers.Interface([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"
]);

export interface TokenRiskDexEnrichment {
  version: 1;
  chainId: number;
  target: HexAddress;
  blockNumber: number;
  observedAt: string;
  engine: {
    name: "agora-token-risk-dex-enrichment";
    version: "1";
    method: "historical-eth-call";
    endpoint: string;
  };
  scope: {
    venue: "PancakeSwap";
    versions: ["v2", "v3"];
    quoteAsset: "WBNB";
  };
  wrappedNative: HexAddress;
  v2: {
    factory: HexAddress;
    router: HexAddress;
    pair: HexAddress;
    pairExists: boolean;
    token0?: HexAddress;
    token1?: HexAddress;
    reserveTokenRaw?: string;
    reserveWrappedNativeRaw?: string;
    lpTotalSupplyRaw?: string;
    tokenReservePartsPerBillionOfSupply?: string;
  };
  v3: {
    factory: HexAddress;
    pools: Array<{
      fee: number;
      pool: HexAddress;
      exists: boolean;
      liquidityRaw?: string;
      sqrtPriceX96?: string;
      tick?: number;
      unlocked?: boolean;
    }>;
  };
  quote: {
    status: "quote-only" | "unavailable";
    inputTokenRaw: string;
    outputWrappedNativeRaw?: string;
    path: [HexAddress, HexAddress];
    limitation: string;
  };
  coverage: {
    liquidity: "measured";
    sellability: "partial";
  };
  interpretation: string;
  limitations: string[];
}

export interface TokenRiskDexEnrichmentDependencies {
  rpc: InvestigationRpc;
  now(): Date;
}

export interface Erc20TransferLog {
  blockNumber: string;
  transactionHash: string;
  topics: string[];
  data: string;
}

export interface Erc20TransferWindowSummary {
  transfers: number;
  uniqueTransactions: number;
  mints: number;
  burns: number;
  uniqueSenders: number;
  uniqueRecipients: number;
  transferredRaw: string;
  firstBlock?: number;
  lastBlock?: number;
}

function addressFromTopic(topic: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error(`${label} is not a 32-byte topic`);
  }
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

export function summarizeErc20TransferWindow(
  logs: readonly Erc20TransferLog[]
): Erc20TransferWindowSummary {
  const transactions = new Set<string>();
  const senders = new Set<string>();
  const recipients = new Set<string>();
  const blocks: number[] = [];
  let mints = 0;
  let burns = 0;
  let transferred = 0n;
  for (const [index, log] of logs.entries()) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
      throw new Error(`Transfer log ${index} has an invalid transaction hash`);
    }
    if (log.topics.length < 3) {
      throw new Error(`Transfer log ${index} has fewer than three topics`);
    }
    if (!/^0x[0-9a-fA-F]+$/.test(log.blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      throw new Error(`Transfer log ${index} has invalid block or value data`);
    }
    const from = addressFromTopic(log.topics[1]!, `Transfer log ${index} sender`);
    const to = addressFromTopic(log.topics[2]!, `Transfer log ${index} recipient`);
    const block = Number(BigInt(log.blockNumber));
    if (!Number.isSafeInteger(block)) {
      throw new Error(`Transfer log ${index} block exceeds the safe integer range`);
    }
    transactions.add(log.transactionHash.toLowerCase());
    blocks.push(block);
    transferred += BigInt(log.data);
    if (from === ethers.ZeroAddress) mints += 1;
    else senders.add(from.toLowerCase());
    if (to === ethers.ZeroAddress) burns += 1;
    else recipients.add(to.toLowerCase());
  }
  return {
    transfers: logs.length,
    uniqueTransactions: transactions.size,
    mints,
    burns,
    uniqueSenders: senders.size,
    uniqueRecipients: recipients.size,
    transferredRaw: transferred.toString(),
    ...(blocks.length > 0 ? {
      firstBlock: Math.min(...blocks),
      lastBlock: Math.max(...blocks)
    } : {})
  };
}

async function readContract(
  rpc: InvestigationRpc,
  address: string,
  contractInterface: ethers.Interface,
  functionName: string,
  blockTag: string,
  args: readonly unknown[] = []
): Promise<ethers.Result> {
  const data = contractInterface.encodeFunctionData(functionName, args);
  const raw = await rpc.call<string>("eth_call", [{ to: address, data }, blockTag]);
  return contractInterface.decodeFunctionResult(functionName, raw);
}

function checkedAddress(value: unknown, label: string): HexAddress {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label} returned an invalid address`);
  }
  return ethers.getAddress(value) as HexAddress;
}

function checkedTokenReport(report: OnchainRiskReport): {
  address: HexAddress;
  totalSupply: bigint;
  decimals: number;
} {
  if (report.chainId !== 97) {
    throw new Error("PancakeSwap enrichment currently supports BSC testnet chain 97 only");
  }
  if (report.target.classification !== "erc20") {
    throw new Error("PancakeSwap enrichment requires an ERC-20 target report");
  }
  const decimals = report.facts.token?.decimals;
  const totalSupply = report.facts.token?.totalSupply;
  if (!Number.isInteger(decimals) || decimals === undefined || decimals < 0 || decimals > 77) {
    throw new Error("ERC-20 report does not contain supported decimals");
  }
  if (typeof totalSupply !== "string" || !/^\d+$/.test(totalSupply)) {
    throw new Error("ERC-20 report does not contain a valid total supply");
  }
  return {
    address: ethers.getAddress(report.target.address) as HexAddress,
    totalSupply: BigInt(totalSupply),
    decimals
  };
}

export async function enrichTokenRiskWithPancakeLiquidity(
  report: OnchainRiskReport,
  deps: TokenRiskDexEnrichmentDependencies
): Promise<TokenRiskDexEnrichment> {
  const token = checkedTokenReport(report);
  const blockTag = ethers.toQuantity(report.blockNumber);
  const wrappedNative = checkedAddress(
    (await readContract(
      deps.rpc,
      PANCAKE_TESTNET.routerV2,
      ROUTER_V2_INTERFACE,
      "WETH",
      blockTag
    ))[0],
    "PancakeSwap V2 router WETH()"
  );
  const pair = checkedAddress(
    (await readContract(
      deps.rpc,
      PANCAKE_TESTNET.factoryV2,
      FACTORY_V2_INTERFACE,
      "getPair",
      blockTag,
      [token.address, wrappedNative]
    ))[0],
    "PancakeSwap V2 factory getPair()"
  );
  const pairExists = pair !== ethers.ZeroAddress;
  const v2: TokenRiskDexEnrichment["v2"] = {
    factory: ethers.getAddress(PANCAKE_TESTNET.factoryV2) as HexAddress,
    router: ethers.getAddress(PANCAKE_TESTNET.routerV2) as HexAddress,
    pair,
    pairExists
  };

  if (pairExists) {
    const [token0Result, token1Result, reserves, lpSupply] = await Promise.all([
      readContract(deps.rpc, pair, PAIR_V2_INTERFACE, "token0", blockTag),
      readContract(deps.rpc, pair, PAIR_V2_INTERFACE, "token1", blockTag),
      readContract(deps.rpc, pair, PAIR_V2_INTERFACE, "getReserves", blockTag),
      readContract(deps.rpc, pair, PAIR_V2_INTERFACE, "totalSupply", blockTag)
    ]);
    const token0 = checkedAddress(token0Result[0], "PancakeSwap V2 pair token0()");
    const token1 = checkedAddress(token1Result[0], "PancakeSwap V2 pair token1()");
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const targetIsToken0 = token0.toLowerCase() === token.address.toLowerCase();
    const targetIsToken1 = token1.toLowerCase() === token.address.toLowerCase();
    if (!targetIsToken0 && !targetIsToken1) {
      throw new Error("PancakeSwap V2 factory returned a pair that does not contain the target");
    }
    const reserveToken = targetIsToken0 ? reserve0 : reserve1;
    const reserveWrappedNative = targetIsToken0 ? reserve1 : reserve0;
    Object.assign(v2, {
      token0,
      token1,
      reserveTokenRaw: reserveToken.toString(),
      reserveWrappedNativeRaw: reserveWrappedNative.toString(),
      lpTotalSupplyRaw: BigInt(lpSupply[0]).toString(),
      tokenReservePartsPerBillionOfSupply: token.totalSupply === 0n
        ? "0"
        : ((reserveToken * 1_000_000_000n) / token.totalSupply).toString()
    });
  }

  const pools: TokenRiskDexEnrichment["v3"]["pools"] = [];
  for (const fee of V3_FEE_TIERS) {
    const pool = checkedAddress(
      (await readContract(
        deps.rpc,
        PANCAKE_TESTNET.factoryV3,
        FACTORY_V3_INTERFACE,
        "getPool",
        blockTag,
        [token.address, wrappedNative, fee]
      ))[0],
      `PancakeSwap V3 getPool(${fee})`
    );
    if (pool === ethers.ZeroAddress) {
      pools.push({ fee, pool, exists: false });
      continue;
    }
    const [liquidity, slot0] = await Promise.all([
      readContract(deps.rpc, pool, POOL_V3_INTERFACE, "liquidity", blockTag),
      readContract(deps.rpc, pool, POOL_V3_INTERFACE, "slot0", blockTag)
    ]);
    pools.push({
      fee,
      pool,
      exists: true,
      liquidityRaw: BigInt(liquidity[0]).toString(),
      sqrtPriceX96: BigInt(slot0[0]).toString(),
      tick: Number(slot0[1]),
      unlocked: Boolean(slot0[6])
    });
  }

  const inputTokenRaw = 10n ** BigInt(token.decimals);
  const quote: TokenRiskDexEnrichment["quote"] = {
    status: "unavailable",
    inputTokenRaw: inputTokenRaw.toString(),
    path: [token.address, wrappedNative],
    limitation: "A router quote is not an executed transfer or swap and cannot prove sellability."
  };
  try {
    const result = await readContract(
      deps.rpc,
      PANCAKE_TESTNET.routerV2,
      ROUTER_V2_INTERFACE,
      "getAmountsOut",
      blockTag,
      [inputTokenRaw, [token.address, wrappedNative]]
    );
    const amounts = result[0] as readonly bigint[];
    if (amounts.length === 2) {
      quote.status = "quote-only";
      quote.outputWrappedNativeRaw = BigInt(amounts[1]!).toString();
    }
  } catch {
    // Quote absence is preserved as unavailable; liquidity facts remain independently measured.
  }

  const activeV3Pools = pools.filter((pool) => BigInt(pool.liquidityRaw ?? "0") > 0n).length;
  const interpretation = pairExists && BigInt(v2.reserveTokenRaw ?? "0") > 0n
    ? `A nonzero PancakeSwap V2 U/WBNB pool exists; ${activeV3Pools} of ${pools.filter((pool) => pool.exists).length} discovered V3 pools had active liquidity at the bound block.`
    : `No nonzero PancakeSwap V2 U/WBNB liquidity was found; ${activeV3Pools} V3 pools had active liquidity at the bound block.`;

  return {
    version: 1,
    chainId: report.chainId,
    target: token.address,
    blockNumber: report.blockNumber,
    observedAt: deps.now().toISOString(),
    engine: {
      name: "agora-token-risk-dex-enrichment",
      version: "1",
      method: "historical-eth-call",
      endpoint: deps.rpc.endpoint
    },
    scope: {
      venue: "PancakeSwap",
      versions: ["v2", "v3"],
      quoteAsset: "WBNB"
    },
    wrappedNative,
    v2,
    v3: {
      factory: ethers.getAddress(PANCAKE_TESTNET.factoryV3) as HexAddress,
      pools
    },
    quote,
    coverage: {
      liquidity: "measured",
      sellability: "partial"
    },
    interpretation,
    limitations: [
      "Liquidity coverage is scoped to PancakeSwap V2/V3 U/WBNB pools and is not an all-DEX market survey.",
      quote.limitation,
      "Historical eth_call proves pool state at the report block but does not prove that present-day liquidity is unchanged."
    ]
  };
}
