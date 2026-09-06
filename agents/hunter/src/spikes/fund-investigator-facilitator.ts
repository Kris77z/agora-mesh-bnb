import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { hunterConfig } from "../config.js";

const CONFIRMATION = "I_UNDERSTAND_TESTNET_GAS_TRANSFER";
const DEFAULT_TARGET_BALANCE_WEI = "200000000000000"; // 0.0002 tBNB

function requiredPrivateKey(name: string): `0x${string}` {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return value as `0x${string}`;
}

function targetBalanceWei(): bigint {
  const value =
    process.env.INVESTIGATOR_FACILITATOR_TARGET_TBNB_WEI?.trim() ||
    DEFAULT_TARGET_BALANCE_WEI;
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error("INVESTIGATOR_FACILITATOR_TARGET_TBNB_WEI must be a positive integer");
  }
  return BigInt(value);
}

async function main(): Promise<void> {
  if (process.env.INVESTIGATOR_FACILITATOR_FUND_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Refusing to broadcast. Set INVESTIGATOR_FACILITATOR_FUND_CONFIRM=${CONFIRMATION} to fund the BNB Testnet facilitator.`
    );
  }
  if (hunterConfig.chainId !== bscTestnet.id) {
    throw new Error("Facilitator funding requires CHAIN_PRESET=bnb-testnet and CHAIN_ID=97");
  }

  const admin = privateKeyToAccount(requiredPrivateKey("ALTANA_X402_ADMIN_PRIVATE_KEY"));
  const facilitator = privateKeyToAccount(
    requiredPrivateKey("INVESTIGATOR_X402_FACILITATOR_PRIVATE_KEY")
  );
  if (admin.address.toLowerCase() === facilitator.address.toLowerCase()) {
    throw new Error("Facilitator must use a wallet distinct from the Authority admin");
  }

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(hunterConfig.rpcUrl)
  });
  const walletClient = createWalletClient({
    account: admin,
    chain: bscTestnet,
    transport: http(hunterConfig.rpcUrl)
  });
  const target = targetBalanceWei();
  const before = await publicClient.getBalance({ address: facilitator.address });
  if (before >= target) {
    process.stdout.write(
      `${JSON.stringify(
        {
          event: "investigator_facilitator_already_funded",
          chainId: bscTestnet.id,
          admin: admin.address,
          facilitator: facilitator.address,
          targetWei: target.toString(),
          balanceWei: before.toString()
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const amount = target - before;
  const adminBalance = await publicClient.getBalance({ address: admin.address });
  const estimatedGas = await publicClient.estimateGas({
    account: admin.address,
    to: facilitator.address,
    value: amount
  });
  const gasPrice = await publicClient.getGasPrice();
  const estimatedCost = amount + estimatedGas * gasPrice;
  if (adminBalance < estimatedCost) {
    throw new Error(
      `Admin ${admin.address} has ${adminBalance} wei but needs at least ${estimatedCost} wei`
    );
  }

  const txHash = await walletClient.sendTransaction({
    account: admin,
    chain: bscTestnet,
    to: facilitator.address,
    value: amount
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Facilitator funding transaction reverted: ${txHash}`);
  }
  const after = await publicClient.getBalance({ address: facilitator.address });
  if (after < target) {
    throw new Error(`Facilitator balance ${after} is below target ${target} after ${txHash}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        event: "investigator_facilitator_funded",
        chainId: bscTestnet.id,
        admin: admin.address,
        facilitator: facilitator.address,
        amountWei: amount.toString(),
        amountTBNB: formatEther(amount),
        balanceWei: after.toString(),
        txHash
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Investigator facilitator funding failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
