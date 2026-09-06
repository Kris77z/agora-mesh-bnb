import { ethers } from "ethers";
import { formatMoney, sameAsset, type Money } from "@rebel/shared";
import { hunterConfig } from "./config.js";
import { HunterError } from "./errors.js";
import { browserAuthorityContext } from './integrations/altana/browser-context.js';

const provider = new ethers.JsonRpcProvider(hunterConfig.rpcUrl, hunterConfig.chainId);
const devWallet = ethers.Wallet.createRandom();

function getWallet(): ethers.HDNodeWallet | ethers.Wallet {
  if (hunterConfig.isMockMode) {
    return devWallet;
  }
  if (!hunterConfig.privateKey) {
    throw new HunterError(500, "WALLET_NOT_CONFIGURED", "HUNTER_PRIVATE_KEY is missing");
  }
  return new ethers.Wallet(hunterConfig.privateKey, provider);
}

export function getHunterAddress(): string {
  const scoped = browserAuthorityContext.getStore();
  if (scoped) return scoped.walletAddress;
  if (hunterConfig.altana.enabled && hunterConfig.altana.walletAddress) {
    return hunterConfig.altana.walletAddress;
  }
  return getWallet().address;
}

export async function checkHunterBalance(): Promise<{
  address: string;
  balance: Money;
  formatted: string;
}> {
  const scoped = browserAuthorityContext.getStore();
  if (scoped) {
    const amount = (await provider.getBalance(scoped.walletAddress)).toString();
    const balance = { asset: hunterConfig.chain.nativeAsset, amount };
    return { address: scoped.walletAddress, balance, formatted: formatMoney(balance) };
  }
  if (hunterConfig.altana.enabled && hunterConfig.altana.walletAddress) {
    const balance = await provider.getBalance(hunterConfig.altana.walletAddress);
    return {
      address: hunterConfig.altana.walletAddress,
      balance: { asset: hunterConfig.chain.nativeAsset, amount: balance.toString() },
      formatted: formatMoney({ asset: hunterConfig.chain.nativeAsset, amount: balance.toString() })
    };
  }
  const wallet = getWallet();
  if (hunterConfig.isMockMode) {
    const fakeWei = "100000000000000000000";
    return {
      address: wallet.address,
      balance: { asset: hunterConfig.chain.nativeAsset, amount: fakeWei },
      formatted: formatMoney({ asset: hunterConfig.chain.nativeAsset, amount: fakeWei })
    };
  }
  const balance = await provider.getBalance(wallet.address);
  return {
    address: wallet.address,
    balance: { asset: hunterConfig.chain.nativeAsset, amount: balance.toString() },
    formatted: formatMoney({ asset: hunterConfig.chain.nativeAsset, amount: balance.toString() })
  };
}

export async function makeNativePayment(input: {
  to: string;
  amount: Money;
}): Promise<{
  txHash: string;
  from: string;
  to: string;
  amount: Money;
}> {
  if (input.amount.asset.kind !== "native" || !sameAsset(input.amount.asset, hunterConfig.chain.nativeAsset)) {
    throw new HunterError(422, "UNSUPPORTED_ASSET", "Native payment asset does not match the active chain");
  }
  const wallet = getWallet();
  if (hunterConfig.isMockMode) {
    return {
      txHash: ethers.keccak256(
        ethers.toUtf8Bytes(
          `${wallet.address}:${input.to}:${input.amount.amount}:${Date.now().toString(10)}`
        )
      ),
      from: wallet.address,
      to: input.to,
      amount: input.amount
    };
  }

  const tx = await wallet.sendTransaction({
    to: input.to,
    value: BigInt(input.amount.amount)
  });
  await tx.wait(1);

  return {
    txHash: tx.hash,
    from: wallet.address,
    to: input.to,
    amount: input.amount
  };
}
