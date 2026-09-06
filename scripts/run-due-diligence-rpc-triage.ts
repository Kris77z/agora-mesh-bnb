import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInvestigationRpc } from "../agents/writer/src/investigation/onchain-investigator.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidatePath = path.join(
  repositoryRoot,
  "evidence/experiment-3-due-diligence/candidate-output.json"
);
const outputPath = path.join(
  repositoryRoot,
  "evidence/experiment-3-due-diligence/runtime-triage-output.json"
);
const rpcUrl = process.env.DUE_DILIGENCE_TRIAGE_RPC_URL ??
  "https://bsc-testnet-rpc.publicnode.com";
const rpc = createInvestigationRpc({ endpoint: rpcUrl, timeoutMs: 15_000, attempts: 2 });
const SELECTORS = {
  owner: "0x8da5cb5b",
  autoOwner: "0xdfdcfc37",
  autoMintMaxLimit: "0x268cbc27",
  nonce: "0xaffed0e0",
  chainId: "0x9a8a0592",
  eip7598EnableFlag: "0x9c3dd17e",
  balanceOf: "0x70a08231",
  initialize: "0x4cd88b7600000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000841747461636b6572000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000341544b0000000000000000000000000000000000000000000000000000000000",
  initializeV2: "0x5cd8a76b"
} as const;

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function blockTagFromNumber(blockNumber: number): string {
  return `0x${blockNumber.toString(16)}`;
}

function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return value.toLowerCase();
}

function decodeWord(raw: string, kind: "address" | "uint" | "bool"): string | boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Invalid ABI word: ${raw}`);
  if (kind === "address") return normalizeAddress(`0x${raw.slice(-40)}`);
  const value = BigInt(raw);
  return kind === "bool" ? value !== 0n : value.toString();
}

async function readFunction(
  target: string,
  blockTag: string,
  functionName: keyof Pick<typeof SELECTORS,
    "owner" | "autoOwner" | "autoMintMaxLimit" | "nonce" | "chainId" |
    "eip7598EnableFlag" | "balanceOf">,
  kind: "address" | "uint" | "bool",
  addressArgument?: string
): Promise<unknown> {
  const data = addressArgument
    ? `${SELECTORS[functionName]}${normalizeAddress(addressArgument).slice(2).padStart(64, "0")}`
    : SELECTORS[functionName];
  const raw = await rpc.call<string>("eth_call", [{ to: target, data }, blockTag]);
  return decodeWord(raw, kind);
}

async function simulateInitializer(
  target: string,
  blockTag: string,
  functionName: "initialize" | "initializeV2",
  args: unknown[]
): Promise<{ status: "call-succeeded" | "reverted"; detail: string }> {
  try {
    if (args.length > 0 && functionName !== "initialize") {
      throw new Error("Unexpected initializer arguments");
    }
    const data = SELECTORS[functionName];
    const raw = await rpc.call<string>("eth_call", [{
      to: target,
      from: "0x000000000000000000000000000000000000dEaD",
      data
    }, blockTag]);
    return { status: "call-succeeded", detail: raw };
  } catch (error) {
    return {
      status: "reverted",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function observe(target: string, blockNumber: number): Promise<unknown> {
  const blockTag = blockTagFromNumber(blockNumber);
  const owner = await readFunction(target, blockTag, "owner", "address") as string;
  const autoOwner = await readFunction(target, blockTag, "autoOwner", "address") as string;
  const storage0 = await rpc.call<string>("eth_getStorageAt", [target, "0x0", blockTag]);
  return {
    blockNumber,
    blockTag,
    owner,
    autoOwner,
    autoMintMaxLimit: await readFunction(target, blockTag, "autoMintMaxLimit", "uint"),
    nonce: await readFunction(target, blockTag, "nonce", "uint"),
    configuredChainId: await readFunction(target, blockTag, "chainId", "uint"),
    eip7598EnableFlag: await readFunction(target, blockTag, "eip7598EnableFlag", "bool"),
    ownerBalanceRaw: await readFunction(target, blockTag, "balanceOf", "uint", owner),
    autoOwnerBalanceRaw: await readFunction(target, blockTag, "balanceOf", "uint", autoOwner),
    initializableStorageSlot0: {
      raw: storage0,
      initializedVersionCandidate: Number(BigInt(storage0) & 0xffn),
      interpretation:
        "OpenZeppelin Initializable stores uint8 _initialized in the low byte for this verified dependency layout; initializer simulations provide the stronger runtime check."
    },
    initializeSimulation: await simulateInitializer(
      target,
      blockTag,
      "initialize",
      ["Attacker", "ATK"]
    ),
    initializeV2Simulation: await simulateInitializer(target, blockTag, "initializeV2", [])
  };
}

async function main(): Promise<void> {
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
    report?: {
      target?: { chainId?: unknown; proxy?: unknown; reportBlock?: unknown; sourceHash?: unknown };
    };
  };
  const target = candidate.report?.target;
  if (
    target?.chainId !== 97 ||
    typeof target.proxy !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(target.proxy) ||
    !Number.isSafeInteger(target.reportBlock) ||
    typeof target.sourceHash !== "string"
  ) {
    throw new Error("Experiment 3 candidate target is missing or malformed");
  }
  const startedAt = new Date();
  const started = performance.now();
  const latestHex = await rpc.call<string>("eth_blockNumber", []);
  const latestBlock = Number(BigInt(latestHex));
  const observations = [];
  for (const blockNumber of [Number(target.reportBlock), latestBlock]) {
    try {
      observations.push({
        status: "measured",
        ...(await observe(normalizeAddress(target.proxy), blockNumber) as Record<string, unknown>)
      });
    } catch (error) {
      observations.push({
        status: "unavailable",
        blockNumber,
        blockTag: blockTagFromNumber(blockNumber),
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const completedAt = new Date();
  const evidence = {
    version: 1,
    experimentId: "full-due-diligence",
    triageKind: "read-only-initializer-and-role-replay",
    settlement: {
      status: "not-paid",
      reason: "Read-only eth_call and eth_getStorageAt; no transaction was signed or broadcast."
    },
    source: {
      candidateFile: "candidate-output.json",
      sourceHash: target.sourceHash,
      target: normalizeAddress(target.proxy),
      reportBlock: target.reportBlock
    },
    rpc: { endpoint: rpc.endpoint, methods: ["eth_blockNumber", "eth_call", "eth_getStorageAt"] },
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number((performance.now() - started).toFixed(3))
    },
    observations,
    limitations: [
      "Initializer simulations prove only the observed block states; they do not prove that deployment and upgrade initialization were atomic.",
      "A pruned historical RPC state is recorded as unavailable and is never replaced by a latest-state claim.",
      "Role and limit semantics still require protocol-policy review; a successful read does not establish that the configured addresses are multisigs or timelocks.",
      "No state-changing method was submitted and no sellability claim is made."
    ]
  };
  await writeJsonAtomic(outputPath, evidence);
  console.log(JSON.stringify({ outputPath, ...evidence }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
