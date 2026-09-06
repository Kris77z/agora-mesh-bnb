import { randomUUID } from "node:crypto";
import {
  BNB_TESTNET,
  PERMIT2_ADDRESS,
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey
} from "@altananetwork/sdk";
import { U_TOKEN } from "@altananetwork/x402-server";
import { withLocalFileLock, type AuthorityRecord } from "@rebel/shared";
import { getAddress } from "viem";
import { hunterConfig } from "../config.js";
import { openAuthorityEvidenceStore } from "../integrations/altana/authority-evidence-store.js";
import { provisionAuthority } from "../integrations/altana/authority-lifecycle.js";
import { createPersistedAltanaSession } from "../integrations/altana/session-codec.js";
import { EncryptedAltanaSessionStore } from "../integrations/altana/session-store.js";

const CONFIRMATION = "I_UNDERSTAND_X402_TESTNET_TXS";

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

function integerAmount(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer amount`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.ALTANA_X402_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Refusing to broadcast. Set ALTANA_X402_CONFIRM=${CONFIRMATION} to provision a BNB Testnet x402 session.`
    );
  }
  if (hunterConfig.chainId !== BNB_TESTNET.chainId) {
    throw new Error("x402 provisioning requires CHAIN_PRESET=bnb-testnet and CHAIN_ID=97");
  }
  const rpcUrlOverride = process.env.ALTANA_RPC_URL_OVERRIDE?.trim();
  const relayUrlOverride = process.env.ALTANA_RELAY_URL_OVERRIDE?.trim();
  const network = {
    ...BNB_TESTNET,
    ...(rpcUrlOverride ? { publicRpcUrl: rpcUrlOverride } : {}),
    ...(relayUrlOverride ? { relayUrl: relayUrlOverride } : {})
  };

  const encryptionKey = requiredEnv("ALTANA_SESSION_ENCRYPTION_KEY");
  const adminSigner = signerFromPrivateKey(privateKeyFromEnv("ALTANA_X402_ADMIN_PRIVATE_KEY"));
  const recipients = requiredEnv("ALTANA_X402_ALLOWED_RECIPIENTS")
    .split(",")
    .map((item) => getAddress(item.trim()));
  if (new Set(recipients.map((item) => item.toLowerCase())).size !== recipients.length) {
    throw new Error("ALTANA_X402_ALLOWED_RECIPIENTS contains duplicate addresses");
  }
  const dailyLimit = integerAmount("ALTANA_X402_DAILY_LIMIT", "2000000000000000000");
  const token = U_TOKEN[97];
  const client = createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer: adminSigner });
  const balances = await client.balances({
    wallet,
    chainId: BNB_TESTNET.chainId,
    tokens: [token.address]
  });
  const tokenBalance = balances.tokens?.[0];
  if (!tokenBalance?.ok || tokenBalance.raw === 0n) {
    throw new Error(`Altana wallet ${wallet.address} has no testnet ${token.symbol} balance`);
  }
  if (balances.native === 0n) {
    throw new Error(`Altana wallet ${wallet.address} has no tBNB for provisioning transactions`);
  }

  const sessionSigner = createPrivateKeySigner();
  const expirySeconds = Number(integerAmount("ALTANA_X402_EXPIRY_SECONDS", "86400"));
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds > 7 * 86400) {
    throw new Error("ALTANA_X402_EXPIRY_SECONDS must not exceed 7 days");
  }
  const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
  const authorityId =
    process.env.ALTANA_AUTHORITY_ID?.trim() || `altana-x402-${randomUUID()}`;
  const store = new EncryptedAltanaSessionStore(hunterConfig.altana.sessionStorePath, encryptionKey);
  const permissions = {
    calls: [{ to: token.address }, { to: PERMIT2_ADDRESS }, ...recipients.map((to) => ({ to }))],
    spend: [{ token: token.address, limit: BigInt(dailyLimit), period: "day" as const }]
  };
  const session = { walletAddress: wallet.address, signer: sessionSigner, publicKey: sessionSigner.publicKey, permissions, expiry };
  const authority: AuthorityRecord = {
    authorityId, walletAddress: wallet.address, sessionPublicKey: session.publicKey,
    chainId: BNB_TESTNET.chainId, allowedCalls: recipients.map((to) => ({ to })),
    spendLimits: [{
      asset: { chainId: 97, kind: "erc20", address: token.address, symbol: token.symbol, decimals: token.decimals },
      limit: dailyLimit, period: "day"
    }],
    expiry, status: "invalid", createdAt: Date.now()
  };
  const evidence = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
  const base = { wallet, signer: adminSigner, chainId: BNB_TESTNET.chainId };
  const result = await withLocalFileLock(`${hunterConfig.altana.sessionStorePath}.lifecycle`, () => provisionAuthority({
    sessions: store, evidence,
    record: createPersistedAltanaSession({ authority, session, signerPrivateKey: sessionSigner._privateKey }),
    grant: () => client.grantSession({ ...base, sessionSigner, permissions, expiry, register: true }),
    approveChecker: () => client.approveSignatureChecker({ ...base, session, checker: PERMIT2_ADDRESS }),
    approveAllowance: () => client.approveTokenForPermit2({ ...base, token: token.address, amount: BigInt(dailyLimit) })
  }));
  process.stdout.write(`${JSON.stringify({ event: "altana_x402_authority_provisioned", ...result }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Altana x402 provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
