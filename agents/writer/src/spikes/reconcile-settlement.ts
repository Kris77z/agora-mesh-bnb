import { createPublicClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { U_TOKEN } from "@altananetwork/x402-server";
import { closeProcessPostgresStores, withLocalFileLock } from "@rebel/shared";
import { writerConfig } from "../config.js";
import { openX402ExecutionStore } from "../x402/receipt-store.js";
import { verifySettlementProof } from "../x402/settlement-proof.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function main() {
  if (process.env.X402_RECONCILE_CONFIRM !== "I_CONFIRM_LOCAL_SETTLEMENT_RECONCILIATION") {
    throw new Error("Set X402_RECONCILE_CONFIRM=I_CONFIRM_LOCAL_SETTLEMENT_RECONCILIATION to update the local settlement journal. This command never broadcasts or calls an LLM.");
  }
  if (writerConfig.chainId !== 97) throw new Error("Reconciliation is restricted to BNB Testnet");
  const key = required("X402_RECONCILE_IDEMPOTENCY_KEY");
  const hash = required("X402_RECONCILE_TX_HASH") as Hex;
  if (!/^0x[\da-f]{64}$/i.test(key) || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Invalid request/transaction hash");
  const payer = getAddress(required("X402_RECONCILE_PAYER"));
  const store = await openX402ExecutionStore(
    writerConfig.x402.receiptStorePath,
    `agora-writer-${writerConfig.serviceProfile}-reconcile`
  );
  const reconcile = async () => {
    const record = await store.get(key);
    if (!record?.request || record.request.idempotencyKey !== key || record.request.serviceId !== record.serviceId) throw new Error("Original journalled request is missing");
    if (record.payment) {
      if (record.payment.transaction !== hash) throw new Error("A different transaction is already attached");
      process.stdout.write("Already reconciled; no change.\n");
      return;
    }
    if (record.settlement?.state !== "uncertain" && !(record.settlement?.state === "attempting" &&
        process.env.X402_RECONCILE_WORKER_STOPPED === "I_CONFIRMED_WORKER_IS_STOPPED")) {
      throw new Error("A crashed attempting settlement requires explicit confirmation that its worker is stopped");
    }
    if (record.request.asset.toLowerCase() !== U_TOKEN[97].address.toLowerCase()) throw new Error("Unsupported payment token");
    const client = createPublicClient({ chain: bscTestnet, transport: http(writerConfig.rpcUrl) });
    if (await client.getChainId() !== 97) throw new Error("RPC returned the wrong chain");
    const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const rail = verifySettlementProof({ request: record.request, chainId: 97, payer,
      recipient: writerConfig.x402.payTo,
      facilitator: privateKeyToAccount(writerConfig.x402.facilitatorPrivateKey as Hex).address, transaction, receipt });
    await store.save({ ...record, settlement: undefined, lastError: undefined,
      payment: { status: "payment-completed", rail: "x402", transaction: hash, network: "eip155:97", payer,
        recipient: getAddress(writerConfig.x402.payTo), transferMethod: rail,
        amount: { asset: { chainId: 97, kind: "erc20", address: U_TOKEN[97].address, symbol: "U", decimals: U_TOKEN[97].decimals }, amount: record.request.amount } },
      updatedAt: Math.floor(Date.now() / 1000) });
    process.stdout.write(JSON.stringify({ event: "settlement_reconciled", requestHash: record.requestHash, transaction: hash, next: "Replay the original unsigned request to resume delivery" }) + "\n");
  };
  if (writerConfig.persistence.backend === "postgres") await reconcile();
  else await withLocalFileLock(`${writerConfig.x402.receiptStorePath}.reconciliation`, reconcile);
}
main().catch(() => {
  process.stderr.write("Settlement reconciliation failed. Check the original journal, transaction and configured profile; no new payment was submitted.\n");
  process.exitCode = 1;
}).finally(() => closeProcessPostgresStores().catch(() => undefined));
