import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { U_TOKEN } from "@altananetwork/x402-server";
import {
  buildCaip2Network,
  calculateX402IdempotencyKey,
  closeProcessPostgresStores,
  getProcessPostgresStore,
  type SecurityTaskInput,
  type X402ExecutionRequest,
  type X402PaymentCompleted
} from "@rebel/shared";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
  type Hex
} from "viem";
import { bscTestnet } from "viem/chains";
import { writerConfig } from "../config.js";
import { executeTask } from "../executor.js";
import { createReceipt } from "../receipt.js";
import { openX402ExecutionStore } from "../x402/receipt-store.js";

const CONFIRMATION = "I_CONFIRM_RECOVER_SETTLED_AUDITOR";
const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

interface MissionStoreFile {
  records?: Record<string, {
    missionId?: string;
    goal?: string;
    authorityId?: string;
    status?: string;
    error?: { code?: string };
    events?: Array<{ type?: string; data?: Record<string, unknown> }>;
  }>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveLockedInlineSource(goal: string): SecurityTaskInput {
  const parsed = JSON.parse(goal) as { source?: unknown; sourceName?: unknown };
  if (typeof parsed.source !== "string" || !parsed.source.trim()) {
    throw new Error("Recovery mission does not contain inline Solidity source");
  }
  const source = parsed.source.trim();
  const sourceName = typeof parsed.sourceName === "string" && parsed.sourceName.trim()
    ? parsed.sourceName.trim()
    : "Contract.sol";
  return {
    chainId: 97,
    mode: "inline-source",
    sourceName,
    source,
    sourceHash: `sha256:${createHash("sha256").update(source).digest("hex")}`
  };
}

async function main(): Promise<void> {
  if (process.env.X402_RECOVERY_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing recovery. Set X402_RECOVERY_CONFIRM=${CONFIRMATION}.`);
  }
  if (writerConfig.serviceProfile !== "auditor" || writerConfig.chainId !== 97) {
    throw new Error("Recovery requires SERVICE_PROFILE=auditor on BNB Testnet");
  }

  const missionId = requiredEnv("X402_RECOVERY_MISSION_ID");
  const authorityId = requiredEnv("X402_RECOVERY_AUTHORITY_ID");
  const paymentTx = requiredEnv("X402_RECOVERY_PAYMENT_TX") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) {
    throw new Error("X402_RECOVERY_PAYMENT_TX must be a transaction hash");
  }

  const postgres = await getProcessPostgresStore("agora-writer-auditor-recovery");
  const repositoryRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
  const mission = postgres
    ? await postgres.pool.query<NonNullable<MissionStoreFile["records"]>[string]>(`
        SELECT mission_id AS "missionId", goal, authority_id AS "authorityId",
               status, error, events
        FROM missions WHERE mission_id = $1
      `, [missionId]).then((value) => value.rows[0])
    : (JSON.parse(
        await readFile(path.join(repositoryRoot, "registry/missions.json"), "utf8")
      ) as MissionStoreFile).records?.[missionId];
  if (!mission || mission.missionId !== missionId) throw new Error("Recovery mission not found");
  const resumableCodes = new Set([
    "X402_PAYMENT_REQUIRED",
    "X402_SERVICE_UNREACHABLE",
    "X402_EXECUTION_FAILED",
    "X402_SETTLEMENT_UNCERTAIN"
  ]);
  if (mission.status !== "failed" || !resumableCodes.has(mission.error?.code ?? "")) {
    throw new Error("Recovery mission is not a failed, resumable x402 settlement");
  }
  if (mission.authorityId !== authorityId) throw new Error("Recovery Authority does not match mission");
  if (!mission.goal) throw new Error("Recovery mission goal is missing");

  const selection = mission.events?.find((event) => event.type === "service_selected")?.data;
  const requirement = mission.events?.find((event) =>
    event.type === "x402_requirement_received" && event.data?.role !== "verifier"
  )?.data;
  if (selection?.id !== "auditor-v1") throw new Error("Recovery mission did not select auditor-v1");
  const requestHash = requirement?.requestHash;
  if (typeof requestHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(requestHash)) {
    throw new Error("Recovery mission requestHash is missing");
  }

  const token = U_TOKEN[97];
  const payer = getAddress(requiredEnv("X402_RECOVERY_PAYER"));
  const recipient = getAddress(writerConfig.x402.payTo);
  const expectedAmount = BigInt(writerConfig.x402.priceAmount);
  if (expectedAmount !== 500000000000000000n) {
    throw new Error("Auditor recovery price must be exactly 0.5 U");
  }

  const publicClient = createPublicClient({ chain: bscTestnet, transport: http(writerConfig.rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 97) throw new Error(`Unexpected recovery chain: ${chainId}`);
  const transactionReceipt = await publicClient.getTransactionReceipt({ hash: paymentTx });
  if (transactionReceipt.status !== "success") throw new Error("Recovery payment transaction failed");
  const transfer = transactionReceipt.logs
    .filter((log) => log.address.toLowerCase() === token.address.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
      } catch {
        return undefined;
      }
    })
    .find((event) =>
      event?.eventName === "Transfer" &&
      getAddress(event.args.from) === payer &&
      getAddress(event.args.to) === recipient &&
      event.args.value === expectedAmount
    );
  if (!transfer) throw new Error("Expected 0.5 U Auditor transfer is absent from recovery transaction");

  const securityInput = resolveLockedInlineSource(mission.goal);
  const result = await executeTask({
    taskType: "smart-contract-audit",
    taskInput: JSON.stringify(securityInput),
    locale: "en-US"
  });
  const receipt = await createReceipt({ requestHash, result });
  const payment: X402PaymentCompleted = {
    status: "payment-completed",
    rail: "x402",
    transaction: paymentTx,
    network: buildCaip2Network(97),
    payer,
    recipient,
    amount: {
      asset: {
        chainId: 97,
        kind: "erc20",
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals
      },
      amount: expectedAmount.toString()
    },
    transferMethod: "permit2-witness"
  };
  const idempotencyKey = calculateX402IdempotencyKey({
    missionId,
    serviceId: "auditor-v1",
    requestHash: requestHash as `0x${string}`
  });
  const response = {
    result,
    receipt,
    payment,
    requestHash: requestHash as `0x${string}`,
    idempotencyKey,
    cached: false
  };
  const persistedRequest = postgres
    ? await postgres.pool.query<{ request: X402ExecutionRequest }>(`
        SELECT request FROM x402_purchases
        WHERE mission_id = $1 AND service_id = 'auditor-v1' AND request_hash = $2
      `, [missionId, requestHash.slice(2).toLowerCase()]).then((value) => value.rows[0]?.request)
    : undefined;
  if (postgres && !persistedRequest) {
    throw new Error("PostgreSQL recovery requires the original x402 purchase request");
  }
  const store = await openX402ExecutionStore(
    writerConfig.x402.receiptStorePath,
    "agora-writer-auditor-recovery"
  );
  await store.save({
    idempotencyKey,
    requestHash: requestHash as `0x${string}`,
    serviceId: "auditor-v1",
    ...(persistedRequest ? { request: persistedRequest } : {}),
    payment,
    response,
    updatedAt: Math.floor(Date.now() / 1000)
  });

  process.stdout.write(`${JSON.stringify({
    event: "settled_x402_auditor_delivery_recovered",
    missionId,
    authorityId,
    requestHash,
    paymentTx,
    blockNumber: transactionReceipt.blockNumber.toString(),
    amountRaw: expectedAmount.toString(),
    receiptProvider: receipt.provider
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Settled x402 Auditor recovery failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}).finally(() => closeProcessPostgresStores().catch(() => undefined));
