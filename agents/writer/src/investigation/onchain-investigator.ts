import { ethers } from "ethers";
import type {
  HexAddress,
  HexHash,
  OnchainRiskLevel,
  OnchainRiskReport,
  OnchainRiskSignal
} from "@rebel/shared";
import { writerConfig } from "../config.js";
import { WriterError } from "../errors.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ERC20_INTERFACE = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)"
]);

const CAPABILITY_SELECTORS = {
  mint: ["mint(address,uint256)", "mint(uint256)"],
  pause: ["pause()", "setPaused(bool)"],
  blacklist: ["blacklist(address,bool)", "setBlacklist(address,bool)"],
  upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"]
} as const;
const READ_ONLY_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionCount"
]);

export interface InvestigationRpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  endpoint: string;
}

export interface OnchainInvestigationDependencies {
  rpc: InvestigationRpc;
  chainId: number;
  now(): Date;
  /** Replay every state read at this exact historical block when provided. */
  blockNumber?: number;
}

interface InvestigationInput {
  address: HexAddress;
  chainId: number;
}

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} returned an invalid hex quantity`);
  }
  return BigInt(value);
}

function parseInput(raw: string, expectedChainId: number): InvestigationInput {
  const trimmed = raw.trim();
  let addressValue: string | undefined;
  let requestedChainId = expectedChainId;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      addressValue = typeof record.address === "string"
        ? record.address
        : typeof record.contractAddress === "string"
          ? record.contractAddress
          : typeof record.tokenAddress === "string"
            ? record.tokenAddress
            : undefined;
      if (record.chainId !== undefined) {
        if (!Number.isSafeInteger(record.chainId) || Number(record.chainId) <= 0) {
          throw new WriterError(400, "INVALID_INVESTIGATION_INPUT", "chainId must be a positive integer");
        }
        requestedChainId = Number(record.chainId);
      }
    }
  } catch (error) {
    if (error instanceof WriterError) throw error;
    addressValue = trimmed.match(/0x[a-fA-F0-9]{40}/)?.[0];
  }
  addressValue ??= trimmed.match(/0x[a-fA-F0-9]{40}/)?.[0];
  if (!addressValue || !ethers.isAddress(addressValue)) {
    throw new WriterError(
      400,
      "INVALID_INVESTIGATION_INPUT",
      "Onchain investigation requires an EVM address or JSON with address"
    );
  }
  if (requestedChainId !== expectedChainId) {
    throw new WriterError(
      409,
      "INVESTIGATION_CHAIN_MISMATCH",
      `Requested chain ${requestedChainId} does not match service chain ${expectedChainId}`
    );
  }
  return {
    address: ethers.getAddress(addressValue) as HexAddress,
    chainId: requestedChainId
  };
}

function publicRpcEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured-rpc";
  }
}

export function createInvestigationRpc(input: {
  endpoint: string;
  timeoutMs: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
}): InvestigationRpc {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts = input.attempts ?? 2;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error("Investigator RPC attempts must be an integer between 1 and 3");
  }
  let requestId = 0;
  let transportQueue: Promise<void> = Promise.resolve();
  return {
    endpoint: publicRpcEndpoint(input.endpoint),
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (!READ_ONLY_RPC_METHODS.has(method)) {
        throw new Error(`Investigator RPC method is not read-only or allowlisted: ${method}`);
      }
      let release!: () => void;
      const previous = transportQueue;
      transportQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      let lastError: unknown;
      try {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const response = await fetchImpl(input.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
              signal: AbortSignal.timeout(input.timeoutMs)
            });
            if (!response.ok) {
              throw new Error(`RPC ${method} returned HTTP ${response.status}`);
            }
            const payload = await response.json() as {
              result?: T;
              error?: { code?: number; message?: string };
            };
            if (payload.error) {
              throw new Error(`RPC ${method} failed: ${payload.error.message ?? payload.error.code ?? "unknown error"}`);
            }
            if (payload.result === undefined) {
              throw new Error(`RPC ${method} returned no result`);
            }
            return payload.result;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      } finally {
        release();
      }
    }
  };
}

async function optionalContractRead(
  rpc: InvestigationRpc,
  address: HexAddress,
  functionName: "name" | "symbol" | "decimals" | "totalSupply" | "owner" | "getOwner",
  blockTag: string
): Promise<unknown | undefined> {
  try {
    const data = ERC20_INTERFACE.encodeFunctionData(functionName);
    const raw = await rpc.call<string>("eth_call", [{ to: address, data }, blockTag]);
    const decoded = ERC20_INTERFACE.decodeFunctionResult(functionName, raw);
    return decoded[0];
  } catch {
    return undefined;
  }
}

function addressFromStorage(value: unknown): HexAddress | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const candidate = `0x${value.slice(-40)}`;
  if (/^0x0{40}$/i.test(candidate)) return undefined;
  return ethers.getAddress(candidate) as HexAddress;
}

function bytecodeContainsSelector(code: string, signatures: readonly string[]): boolean {
  const normalized = code.toLowerCase();
  return signatures.some((signature) => normalized.includes(ethers.id(signature).slice(2, 10)));
}

export function readRuntimeOpcodes(code: string): Set<number> {
  const bytes = ethers.getBytes(code);
  const opcodes = new Set<number>();
  for (let index = 0; index < bytes.length; index += 1) {
    const opcode = bytes[index]!;
    opcodes.add(opcode);
    if (opcode >= 0x60 && opcode <= 0x7f) {
      index += opcode - 0x5f;
    }
  }
  return opcodes;
}

function signal(
  target: OnchainRiskSignal[],
  input: Omit<OnchainRiskSignal, "confidence"> & { confidence?: number }
): void {
  target.push({ ...input, confidence: input.confidence ?? 0.9 });
}

function riskLevel(score: number): OnchainRiskLevel {
  if (score >= 65) return "critical";
  if (score >= 35) return "high";
  if (score >= 15) return "medium";
  return "low";
}

export async function investigateOnchainTarget(
  rawInput: string,
  deps: OnchainInvestigationDependencies
): Promise<OnchainRiskReport> {
  const input = parseInput(rawInput, deps.chainId);
  if (
    deps.blockNumber !== undefined &&
    (!Number.isSafeInteger(deps.blockNumber) || deps.blockNumber < 0)
  ) {
    throw new Error("Replay block number must be a non-negative safe integer");
  }
  const observedAt = deps.now().toISOString();
  const blockTag = deps.blockNumber === undefined ? "latest" : ethers.toQuantity(deps.blockNumber);
  const methods = new Set<string>([
    "eth_getBalance",
    "eth_getTransactionCount",
    "eth_getCode"
  ]);
  if (deps.blockNumber === undefined) methods.add("eth_blockNumber");
  const [blockRaw, balanceRaw, transactionCountRaw, code] = await Promise.all([
    deps.blockNumber === undefined
      ? deps.rpc.call<string>("eth_blockNumber", [])
      : Promise.resolve(ethers.toQuantity(deps.blockNumber)),
    deps.rpc.call<string>("eth_getBalance", [input.address, blockTag]),
    deps.rpc.call<string>("eth_getTransactionCount", [input.address, blockTag]),
    deps.rpc.call<string>("eth_getCode", [input.address, blockTag])
  ]);
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
    throw new Error("eth_getCode returned invalid bytecode");
  }
  const blockNumber = Number(parseHexQuantity(blockRaw, "eth_blockNumber"));
  if (!Number.isSafeInteger(blockNumber)) throw new Error("Block number exceeds safe integer range");
  const nativeBalanceWei = parseHexQuantity(balanceRaw, "eth_getBalance").toString();
  const transactionCount = parseHexQuantity(
    transactionCountRaw,
    "eth_getTransactionCount"
  ).toString();
  const isContract = code !== "0x";
  const bytecodeSize = isContract ? (code.length - 2) / 2 : 0;

  let token: OnchainRiskReport["facts"]["token"];
  let owner: HexAddress | undefined;
  let ownerProbe: OnchainRiskReport["facts"]["ownership"]["probe"] = "unavailable";
  let implementation: HexAddress | undefined;
  let admin: HexAddress | undefined;
  let implementationCode: string | undefined;
  const riskSignals: OnchainRiskSignal[] = [];
  let score = 0;

  if (isContract) {
    methods.add("eth_call");
    methods.add("eth_getStorageAt");
    const [name, symbol, decimals, totalSupply, ownerResult, getOwnerResult, implementationRaw, adminRaw] =
      await Promise.all([
        optionalContractRead(deps.rpc, input.address, "name", blockTag),
        optionalContractRead(deps.rpc, input.address, "symbol", blockTag),
        optionalContractRead(deps.rpc, input.address, "decimals", blockTag),
        optionalContractRead(deps.rpc, input.address, "totalSupply", blockTag),
        optionalContractRead(deps.rpc, input.address, "owner", blockTag),
        optionalContractRead(deps.rpc, input.address, "getOwner", blockTag),
        deps.rpc.call<string>("eth_getStorageAt", [
          input.address,
          EIP1967_IMPLEMENTATION_SLOT,
          blockTag
        ]).catch(() => undefined),
        deps.rpc.call<string>("eth_getStorageAt", [input.address, EIP1967_ADMIN_SLOT, blockTag])
          .catch(() => undefined)
      ]);
    const tokenFacts = {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof symbol === "string" ? { symbol } : {}),
      ...(typeof decimals === "bigint" && decimals <= 255n ? { decimals: Number(decimals) } : {}),
      ...(typeof totalSupply === "bigint" ? { totalSupply: totalSupply.toString() } : {})
    };
    if (Object.keys(tokenFacts).length > 0) token = tokenFacts;
    if (typeof ownerResult === "string" && ethers.isAddress(ownerResult)) {
      owner = ethers.getAddress(ownerResult) as HexAddress;
      ownerProbe = "owner()";
    } else if (typeof getOwnerResult === "string" && ethers.isAddress(getOwnerResult)) {
      owner = ethers.getAddress(getOwnerResult) as HexAddress;
      ownerProbe = "getOwner()";
    }
    implementation = addressFromStorage(implementationRaw);
    admin = addressFromStorage(adminRaw);
    if (implementation) {
      implementationCode = await deps.rpc
        .call<string>("eth_getCode", [implementation, blockTag])
        .catch(() => undefined);
      if (implementationCode && !/^0x(?:[0-9a-fA-F]{2})*$/.test(implementationCode)) {
        implementationCode = undefined;
      }
    }
    if (owner && owner !== ethers.ZeroAddress) {
      score += 8;
      signal(riskSignals, {
        id: "privileged-owner",
        severity: "low",
        title: "Privileged owner is active",
        evidence: `${ownerProbe} returned ${owner}`
      });
    }
    if (implementation || admin) {
      score += 15;
      signal(riskSignals, {
        id: "eip1967-upgradeability",
        severity: admin ? "medium" : "low",
        title: "EIP-1967 proxy control detected",
        evidence: `implementation=${implementation ?? "unset"}; admin=${admin ?? "unset"}`
      });
    }
    const scanTargets = [
      { label: "proxy/runtime", code },
      ...(implementationCode && implementationCode !== "0x"
        ? [{ label: "implementation/runtime", code: implementationCode }]
        : [])
    ];
    for (const [capability, signatures] of Object.entries(CAPABILITY_SELECTORS)) {
      const matches = scanTargets.filter((target) => bytecodeContainsSelector(target.code, signatures));
      if (matches.length === 0) continue;
      if (capability === "upgrade" && implementation && matches.every((target) => target.label === "proxy/runtime")) {
        continue;
      }
      const weights = { mint: 20, pause: 8, blacklist: 18, upgrade: 15 } as const;
      const severities = {
        mint: "high",
        pause: "medium",
        blacklist: "high",
        upgrade: "high"
      } as const;
      score += weights[capability as keyof typeof weights];
      signal(riskSignals, {
        id: `bytecode-capability-${capability}`,
        severity: severities[capability as keyof typeof severities],
        title: `${capability} capability selector appears in runtime bytecode`,
        evidence: `${matches.map((target) => target.label).join(", ")} matched one of: ${signatures.join(", ")}`,
        confidence: 0.65
      });
    }
    const proxyOpcodes = readRuntimeOpcodes(code);
    const implementationOpcodes = implementationCode && implementationCode !== "0x"
      ? readRuntimeOpcodes(implementationCode)
      : undefined;
    if (proxyOpcodes.has(0xf4) || implementationOpcodes?.has(0xf4)) {
      const expectedProxyDispatch = Boolean(implementation && proxyOpcodes.has(0xf4) && !implementationOpcodes?.has(0xf4));
      score += expectedProxyDispatch ? 0 : 12;
      signal(riskSignals, {
        id: "runtime-delegatecall",
        severity: expectedProxyDispatch ? "info" : "medium",
        title: "Runtime bytecode can execute DELEGATECALL",
        evidence: expectedProxyDispatch
          ? "Opcode-aware scan found DELEGATECALL (0xf4) only in the EIP-1967 proxy runtime; treated as expected dispatch plumbing."
          : "Opcode-aware scan found DELEGATECALL (0xf4) outside expected proxy-only dispatch.",
        confidence: 0.85
      });
    }
    if (proxyOpcodes.has(0xff) || implementationOpcodes?.has(0xff)) {
      score += 25;
      signal(riskSignals, {
        id: "runtime-selfdestruct",
        severity: "high",
        title: "Runtime bytecode contains SELFDESTRUCT",
        evidence: "Opcode-aware scan found SELFDESTRUCT (0xff)",
        confidence: 0.85
      });
    }
  }

  const classification = !isContract
    ? "eoa"
    : token?.totalSupply !== undefined && token.symbol !== undefined
      ? "erc20"
      : "contract";
  const normalizedScore = Math.min(100, score);
  const coverage: OnchainRiskReport["coverage"] = {
    accountState: "measured",
    contractBytecode: "measured",
    tokenMetadata: !isContract
      ? "not-applicable"
      : classification === "erc20"
        ? "measured"
        : token
          ? "partial"
          : "not-applicable",
    ownership: ownerProbe === "unavailable" ? "unavailable" : "measured",
    proxySlots: "measured",
    holderConcentration: "not-measured",
    liquidity: "not-measured",
    recentTransactions: "not-measured"
  };
  const limitations = [
    "Holder concentration is not measured without a complete indexed holder dataset.",
    "Liquidity and sellability are not measured without verified DEX pool evidence.",
    "Transaction count is measured, but recent transaction behavior is not classified in this RPC-only profile.",
    "Bytecode selector matches indicate capability presence, not proof that every caller can use it."
  ];
  return {
    version: 1,
    chainId: input.chainId,
    target: {
      address: input.address,
      classification,
      bytecodeSize,
      ...(isContract ? { bytecodeHash: ethers.keccak256(code) as HexHash } : {})
    },
    observedAt,
    blockNumber,
    sources: [{
      kind: "rpc",
      endpoint: deps.rpc.endpoint,
      methods: [...methods].sort(),
      observedAt
    }],
    facts: {
      nativeBalanceWei,
      transactionCount,
      ...(token ? { token } : {}),
      ownership: {
        ...(owner ? { owner, renounced: owner === ethers.ZeroAddress } : {}),
        probe: ownerProbe
      },
      proxy: {
        standard: "eip-1967",
        ...(implementation ? { implementation } : {}),
        ...(admin ? { admin } : {}),
        ...(implementationCode && implementationCode !== "0x"
          ? {
              implementationBytecodeSize: (implementationCode.length - 2) / 2,
              implementationBytecodeHash: ethers.keccak256(implementationCode) as HexHash
            }
          : {})
      }
    },
    riskSignals,
    riskScore: normalizedScore,
    riskLevel: riskLevel(normalizedScore),
    coverage,
    limitations,
    recommendation: normalizedScore >= 35
      ? "Treat the target as elevated risk until privileged capabilities, proxy control, holders, and liquidity are manually verified."
      : "No high-confidence critical capability was established by this RPC snapshot; complete holder, liquidity, and transaction analysis before making a trust decision."
  };
}

export function runProductionOnchainInvestigation(taskInput: string): Promise<OnchainRiskReport> {
  return investigateOnchainTarget(taskInput, {
    chainId: writerConfig.chainId,
    now: () => new Date(),
    rpc: createInvestigationRpc({
      endpoint: writerConfig.rpcUrl,
      timeoutMs: writerConfig.investigator.rpcTimeoutMs,
      attempts: writerConfig.investigator.rpcAttempts
    })
  });
}
