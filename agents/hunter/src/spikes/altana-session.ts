import { randomUUID } from "node:crypto";
import {
  BNB_TESTNET,
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey
} from "@altananetwork/sdk";
import { assertAmount, BNB_TESTNET_CHAIN, type AuthorityRecord } from "@rebel/shared";
import { getAddress } from "viem";
import { hunterConfig } from "../config.js";
import { createPersistedAltanaSession } from "../integrations/altana/session-codec.js";
import { EncryptedAltanaSessionStore } from "../integrations/altana/session-store.js";

const CONFIRMATION = "I_UNDERSTAND_TESTNET_TXS";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function privateKeyFromEnv(name: string): `0x${string}` {
  const value = requiredEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return value as `0x${string}`;
}

function transactionHash(label: string, value: string | undefined): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} did not return a transaction hash`);
  }
  return value as `0x${string}`;
}

function confirmed(
  label: string,
  result: { status: string; transactionHash?: string }
): `0x${string}` {
  if (result.status !== "CONFIRMED" || !result.transactionHash) {
    throw new Error(
      `${label} was not confirmed (status=${result.status}, tx=${result.transactionHash ?? "none"})`
    );
  }
  return transactionHash(label, result.transactionHash);
}

async function main() {
  if (process.env.ALTANA_SPIKE_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Refusing to broadcast. Set ALTANA_SPIKE_CONFIRM=${CONFIRMATION} to run the BNB Testnet spike.`
    );
  }
  if (hunterConfig.chainId !== BNB_TESTNET.chainId) {
    throw new Error("Altana spike requires CHAIN_PRESET=bnb-testnet and CHAIN_ID=97");
  }

  const encryptionKey = requiredEnv("ALTANA_SESSION_ENCRYPTION_KEY");
  const adminSigner = signerFromPrivateKey(privateKeyFromEnv("ALTANA_SPIKE_ADMIN_PRIVATE_KEY"));
  const recipient = getAddress(requiredEnv("ALTANA_SPIKE_RECIPIENT"));
  const amount = process.env.ALTANA_SPIKE_AMOUNT?.trim() || "1";
  assertAmount(amount);
  if (BigInt(amount) === 0n) {
    throw new Error("ALTANA_SPIKE_AMOUNT must be greater than zero");
  }
  const spendLimit = (BigInt(amount) * 2n).toString();

  const client = createClient({ chains: [BNB_TESTNET] });
  const wallet = await client.createWallet({ signer: adminSigner });
  const balances = await client.balances({ wallet, chainId: BNB_TESTNET.chainId });
  if (balances.native < BigInt(amount)) {
    throw new Error(
      `Altana wallet ${wallet.address} needs at least ${amount} wei of tBNB before the spike can run`
    );
  }

  const sessionSigner = createPrivateKeySigner();
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
  const authorityId = process.env.ALTANA_AUTHORITY_ID?.trim() || `altana-spike-${randomUUID()}`;
  const store = new EncryptedAltanaSessionStore(hunterConfig.altana.sessionStorePath, encryptionKey);

  const grant = await client.grantSession({
    wallet,
    signer: adminSigner,
    chainId: BNB_TESTNET.chainId,
    sessionSigner,
    permissions: {
      calls: [{ to: recipient }],
      spend: [{ limit: BigInt(spendLimit), period: "day" }]
    },
    expiry,
    register: true
  });
  const grantTxHash = transactionHash("grantSession", grant.transactionHash);
  const authority: AuthorityRecord = {
    authorityId,
    walletAddress: wallet.address,
    sessionPublicKey: grant.publicKey,
    chainId: BNB_TESTNET.chainId,
    allowedCalls: [{ to: recipient }],
    spendLimits: [
      { asset: BNB_TESTNET_CHAIN.nativeAsset, limit: spendLimit, period: "day" }
    ],
    expiry,
    status: "active",
    grantTxHash,
    createdAt: Date.now()
  };
  await store.save(
    authorityId,
    createPersistedAltanaSession({
      authority,
      session: grant,
      signerPrivateKey: sessionSigner._privateKey
    })
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "altana_session_granted",
      chainId: BNB_TESTNET.chainId,
      authorityId,
      walletAddress: wallet.address,
      sessionPublicKey: grant.publicKey,
      grantTxHash
    })}\n`
  );

  let executeTxHash: `0x${string}` | undefined;
  let executeError: unknown;
  try {
    const execute = await client.execute({
      session: grant,
      chainId: BNB_TESTNET.chainId,
      calls: [{ to: recipient, value: BigInt(amount) }]
    });
    executeTxHash = confirmed("execute", execute);
  } catch (error) {
    executeError = error;
  }

  const revoke = await client.revokeSession({
    wallet,
    signer: adminSigner,
    session: grant,
    chainId: BNB_TESTNET.chainId
  });
  const revokeTxHash = confirmed("revokeSession", revoke);
  await store.save(
    authorityId,
    createPersistedAltanaSession({
      authority: { ...authority, status: "revoked", revokeTxHash },
      session: grant,
      signerPrivateKey: sessionSigner._privateKey
    })
  );

  let rejectedAfterRevoke = false;
  try {
    const afterRevoke = await client.execute({
      session: grant,
      chainId: BNB_TESTNET.chainId,
      calls: [{ to: recipient, value: BigInt(amount) }]
    });
    rejectedAfterRevoke = afterRevoke.status !== "CONFIRMED";
  } catch {
    rejectedAfterRevoke = true;
  }
  if (!rejectedAfterRevoke) {
    throw new Error("Revoked session unexpectedly executed a transaction; encrypted material was retained");
  }

  await store.delete(authorityId);
  if (executeError) {
    throw executeError;
  }
  if (!executeTxHash) {
    throw new Error("execute did not produce a transaction hash");
  }
  const explorer = BNB_TESTNET_CHAIN.explorerUrl;
  process.stdout.write(
    `${JSON.stringify(
      {
        chainId: BNB_TESTNET.chainId,
        authorityId,
        walletAddress: wallet.address,
        sessionPublicKey: grant.publicKey,
        recipient,
        amount: { asset: BNB_TESTNET_CHAIN.nativeAsset, amount },
        grant: { txHash: grantTxHash, explorer: `${explorer}/tx/${grantTxHash}` },
        execute: { txHash: executeTxHash, explorer: `${explorer}/tx/${executeTxHash}` },
        revoke: { txHash: revokeTxHash, explorer: `${explorer}/tx/${revokeTxHash}` },
        rejectedAfterRevoke,
        sessionMaterialDeleted: true
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Altana spike failed: ${message}\n`);
  process.exitCode = 1;
});
