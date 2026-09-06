import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  parseAbiItem
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { hunterConfig } from "../config.js";

const CONFIRMATION = "I_UNDERSTAND_ORPHAN_REFUND_TXS";
const EXPECTED_ADMIN = "0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d";
const EXPECTED_AUDITOR = "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527";
const U_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const ORPHAN_PAYMENT_TX =
  "0x0f55a8d790a6567218d667f1d0408826f60ae2697021598ebc2e5ac16d666a82";
const REFUND_AMOUNT = 500_000_000_000_000_000n;
const MAX_GAS_TOP_UP = 10_000_000_000_000n; // 0.00001 tBNB

function requiredPrivateKey(name: string): `0x${string}` {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return value as `0x${string}`;
}

async function main(): Promise<void> {
  if (process.env.ORPHAN_REFUND_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Refusing to broadcast. Set ORPHAN_REFUND_CONFIRM=${CONFIRMATION} to refund the orphaned testnet payment.`
    );
  }
  if (hunterConfig.chainId !== bscTestnet.id) {
    throw new Error("Orphan refund requires CHAIN_PRESET=bnb-testnet and CHAIN_ID=97");
  }

  const admin = privateKeyToAccount(requiredPrivateKey("ALTANA_X402_ADMIN_PRIVATE_KEY"));
  const auditor = privateKeyToAccount(requiredPrivateKey("AUDITOR_PRIVATE_KEY"));
  if (admin.address.toLowerCase() !== EXPECTED_ADMIN.toLowerCase()) {
    throw new Error(`Admin key controls unexpected address ${admin.address}`);
  }
  if (auditor.address.toLowerCase() !== EXPECTED_AUDITOR.toLowerCase()) {
    throw new Error(`Auditor key controls unexpected address ${auditor.address}`);
  }

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(hunterConfig.rpcUrl)
  });
  const adminClient = createWalletClient({
    account: admin,
    chain: bscTestnet,
    transport: http(hunterConfig.rpcUrl)
  });
  const auditorClient = createWalletClient({
    account: auditor,
    chain: bscTestnet,
    transport: http(hunterConfig.rpcUrl)
  });

  const orphanReceipt = await publicClient.getTransactionReceipt({ hash: ORPHAN_PAYMENT_TX });
  if (orphanReceipt.status !== "success") {
    throw new Error(`Orphan payment transaction was not successful: ${ORPHAN_PAYMENT_TX}`);
  }
  const transferLogs = await publicClient.getLogs({
    address: U_TOKEN,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
    fromBlock: orphanReceipt.blockNumber,
    toBlock: orphanReceipt.blockNumber
  });
  const orphanTransfer = transferLogs.find(
    (log) =>
      log.transactionHash?.toLowerCase() === ORPHAN_PAYMENT_TX.toLowerCase() &&
      log.args.from?.toLowerCase() === admin.address.toLowerCase() &&
      log.args.to?.toLowerCase() === auditor.address.toLowerCase() &&
      log.args.value === REFUND_AMOUNT
  );
  if (!orphanTransfer) {
    throw new Error("Expected 0.5 U orphan transfer was not found in the referenced transaction");
  }

  const [adminBefore, auditorBefore, auditorNativeBefore] = await Promise.all([
    publicClient.readContract({
      address: U_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [admin.address]
    }),
    publicClient.readContract({
      address: U_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [auditor.address]
    }),
    publicClient.getBalance({ address: auditor.address })
  ]);
  if (auditorBefore < REFUND_AMOUNT) {
    throw new Error(
      `Auditor ${auditor.address} has ${auditorBefore} raw U but needs ${REFUND_AMOUNT}`
    );
  }

  const estimatedRefundGas = await publicClient.estimateContractGas({
    account: auditor,
    address: U_TOKEN,
    abi: erc20Abi,
    functionName: "transfer",
    args: [admin.address, REFUND_AMOUNT]
  });
  const refundGas = (estimatedRefundGas * 120n + 99n) / 100n;
  const gasPrice = await publicClient.getGasPrice();
  const requiredAuditorNative = refundGas * gasPrice;
  const topUpAmount =
    auditorNativeBefore >= requiredAuditorNative ? 0n : requiredAuditorNative - auditorNativeBefore;
  if (topUpAmount > MAX_GAS_TOP_UP) {
    throw new Error(
      `Required gas top-up ${topUpAmount} exceeds confirmed maximum ${MAX_GAS_TOP_UP}`
    );
  }

  let gasTopUpTxHash: `0x${string}` | null = null;
  if (topUpAmount > 0n) {
    gasTopUpTxHash = await adminClient.sendTransaction({
      account: admin,
      chain: bscTestnet,
      to: auditor.address,
      value: topUpAmount
    });
    const topUpReceipt = await publicClient.waitForTransactionReceipt({ hash: gasTopUpTxHash });
    if (topUpReceipt.status !== "success") {
      throw new Error(`Auditor gas top-up reverted: ${gasTopUpTxHash}`);
    }
    const fundedBalance = await publicClient.getBalance({ address: auditor.address });
    if (fundedBalance < requiredAuditorNative) {
      throw new Error(
        `Auditor native balance ${fundedBalance} is below required ${requiredAuditorNative}`
      );
    }
  }

  const refundTxHash = await auditorClient.writeContract({
    account: auditor,
    chain: bscTestnet,
    address: U_TOKEN,
    abi: erc20Abi,
    functionName: "transfer",
    args: [admin.address, REFUND_AMOUNT],
    gas: refundGas,
    gasPrice
  });
  const refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundTxHash });
  if (refundReceipt.status !== "success") {
    throw new Error(`Orphan payment refund reverted: ${refundTxHash}`);
  }

  const [adminAfter, auditorAfter, auditorNativeAfter] = await Promise.all([
    publicClient.readContract({
      address: U_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [admin.address]
    }),
    publicClient.readContract({
      address: U_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [auditor.address]
    }),
    publicClient.getBalance({ address: auditor.address })
  ]);
  if (adminAfter - adminBefore !== REFUND_AMOUNT || auditorBefore - auditorAfter !== REFUND_AMOUNT) {
    throw new Error("Post-refund U balance deltas do not equal exactly 0.5 U");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        event: "orphaned_auditor_payment_refunded",
        chainId: bscTestnet.id,
        token: U_TOKEN,
        admin: admin.address,
        auditor: auditor.address,
        sourcePaymentTxHash: ORPHAN_PAYMENT_TX,
        refundAmountRaw: REFUND_AMOUNT.toString(),
        refundAmountU: formatUnits(REFUND_AMOUNT, 18),
        gas: {
          estimatedRefundGas: estimatedRefundGas.toString(),
          refundGas: refundGas.toString(),
          gasPriceWei: gasPrice.toString(),
          topUpAmountWei: topUpAmount.toString(),
          topUpAmountTBNB: formatEther(topUpAmount),
          topUpTxHash: gasTopUpTxHash,
          auditorNativeAfterWei: auditorNativeAfter.toString()
        },
        refundTxHash,
        balances: {
          adminBeforeRaw: adminBefore.toString(),
          adminAfterRaw: adminAfter.toString(),
          auditorBeforeRaw: auditorBefore.toString(),
          auditorAfterRaw: auditorAfter.toString()
        }
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Orphaned auditor payment refund failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
