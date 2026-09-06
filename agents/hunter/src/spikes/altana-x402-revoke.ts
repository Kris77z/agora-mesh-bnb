import { BNB_TESTNET, PERMIT2_ADDRESS, createClient, signerFromPrivateKey } from "@altananetwork/sdk";
import { U_TOKEN } from "@altananetwork/x402-server";
import { withLocalFileLock } from "@rebel/shared";
import { encodeFunctionData, erc20Abi } from "viem";
import { hunterConfig } from "../config.js";
import { openAuthorityEvidenceStore } from "../integrations/altana/authority-evidence-store.js";
import { revokeAuthority } from "../integrations/altana/authority-lifecycle.js";
import { restoreAltanaSession } from "../integrations/altana/session-codec.js";
import { EncryptedAltanaSessionStore } from "../integrations/altana/session-store.js";

const CONFIRMATION = "I_UNDERSTAND_X402_TESTNET_TXS";
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.ALTANA_X402_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing to broadcast. Set ALTANA_X402_CONFIRM=${CONFIRMATION} to revoke the x402 session.`);
  }
  if (hunterConfig.chainId !== 97) throw new Error("Revoke requires CHAIN_ID=97");
  const authorityId = requiredEnv("ALTANA_AUTHORITY_ID");
  const sessions = new EncryptedAltanaSessionStore(hunterConfig.altana.sessionStorePath, requiredEnv("ALTANA_SESSION_ENCRYPTION_KEY"));
  const evidence = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
  await withLocalFileLock(`${hunterConfig.altana.sessionStorePath}.lifecycle`, async () => {
    const record = await sessions.load(authorityId);
    // Idempotent local completion: no wallet/RPC access after key deletion.
    if (!record) {
      const unavailable = async (): Promise<never> => { throw new Error("No session material"); };
      const result = await revokeAuthority({
        authorityId, sessions, evidence, revokeChecker: unavailable, revokeAllowance: unavailable,
        revokeSession: unavailable, negativeTest: unavailable
      });
      process.stdout.write(`${JSON.stringify({ event: "altana_x402_authority_already_revoked", ...result }, null, 2)}\n`);
      return;
    }
    const privateKey = requiredEnv("ALTANA_X402_ADMIN_PRIVATE_KEY");
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Admin private key must be 32-byte hex");
    const adminSigner = signerFromPrivateKey(privateKey as `0x${string}`);
    const rpcUrl = process.env.ALTANA_RPC_URL_OVERRIDE?.trim();
    const relayUrl = process.env.ALTANA_RELAY_URL_OVERRIDE?.trim();
    const client = createClient({ chains: [{
      ...BNB_TESTNET, ...(rpcUrl ? { publicRpcUrl: rpcUrl } : {}), ...(relayUrl ? { relayUrl } : {})
    }] });
    const wallet = await client.createWallet({ signer: adminSigner });
    if (wallet.address.toLowerCase() !== record.authority.walletAddress.toLowerCase()) {
      throw new Error("Admin key does not control the persisted authority wallet");
    }
    const session = restoreAltanaSession(record);
    const base = { wallet, signer: adminSigner, session, chainId: BNB_TESTNET.chainId };
    const result = await revokeAuthority({
      authorityId, sessions, evidence,
      revokeChecker: () => client.revokeSignatureChecker({ ...base, checker: PERMIT2_ADDRESS }),
      revokeAllowance: () => client.approveTokenForPermit2({ ...base, token: U_TOKEN[97].address, amount: 0n }),
      revokeSession: () => client.revokeSession(base),
      negativeTest: (recipient) => client.execute({
        session, chainId: BNB_TESTNET.chainId,
        calls: [{
          to: U_TOKEN[97].address, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 1n] })
        }]
      })
    });
    process.stdout.write(`${JSON.stringify({ event: "altana_x402_authority_revoked", ...result }, null, 2)}\n`);
  });
}
main().catch((error: unknown) => {
  process.stderr.write(`Altana x402 revoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
