import { ethers } from "ethers";
import { BNB_TESTNET, PERMIT2_ADDRESS, createClient, signerFromPrivateKey } from "@altananetwork/sdk";
import { U_TOKEN } from "@altananetwork/x402-server";
import { withLocalFileLock } from "@rebel/shared";
import { hunterConfig } from "../config.js";
import { openAuthorityEvidenceStore } from "../integrations/altana/authority-evidence-store.js";
import { resumeProvisionAuthority } from "../integrations/altana/authority-lifecycle.js";
import { restoreAltanaSession } from "../integrations/altana/session-codec.js";
import { EncryptedAltanaSessionStore } from "../integrations/altana/session-store.js";

const CONFIRMATION = "I_UNDERSTAND_X402_TESTNET_TXS";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.ALTANA_X402_CONFIRM !== CONFIRMATION) throw new Error("Explicit x402 transaction confirmation is required");
  if (hunterConfig.chainId !== 97) throw new Error("Provision recovery requires BNB Testnet chain 97");
  const authorityId = required("ALTANA_AUTHORITY_ID");
  const sessions = new EncryptedAltanaSessionStore(hunterConfig.altana.sessionStorePath, required("ALTANA_SESSION_ENCRYPTION_KEY"));
  const evidence = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
  await withLocalFileLock(`${hunterConfig.altana.sessionStorePath}.lifecycle`, async () => {
    const record = await sessions.load(authorityId);
    if (!record) throw new Error(`Authority recovery material not found: ${authorityId}`);
    const privateKey = required("ALTANA_X402_ADMIN_PRIVATE_KEY");
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Admin private key is invalid");
    const adminSigner = signerFromPrivateKey(privateKey as `0x${string}`);
    const rpcUrl = process.env.ALTANA_RPC_URL_OVERRIDE?.trim() || hunterConfig.rpcUrl;
    const relayUrl = process.env.ALTANA_RELAY_URL_OVERRIDE?.trim();
    const network = { ...BNB_TESTNET, publicRpcUrl: rpcUrl, ...(relayUrl ? { relayUrl } : {}) };
    const client = createClient({ chains: [network] });
    const wallet = await client.createWallet({ signer: adminSigner });
    if (wallet.address.toLowerCase() !== record.authority.walletAddress.toLowerCase()) throw new Error("Admin key does not control this Authority");
    const session = restoreAltanaSession(record);
    const signerAddress = session.signer.address;
    const publicKeyHash = ethers.keccak256(ethers.zeroPadValue(signerAddress, 32));
    const keyHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [2n, publicKeyHash]));
    const provider = new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true });
    const account = new ethers.Contract(wallet.address, ["function approvedSignatureCheckers(bytes32) view returns (address[])"] , provider);
    const token = new ethers.Contract(U_TOKEN[97].address, ["function allowance(address,address) view returns (uint256)"], provider);
    const limit = BigInt(record.authority.spendLimits[0]?.limit ?? "0");
    const base = { wallet, signer: adminSigner, session, chainId: 97 };
    const result = await resumeProvisionAuthority({
      authorityId, sessions, evidence,
      checkerApproved: async () => {
        const approved = await account.approvedSignatureCheckers(keyHash) as string[];
        return approved.some((address) => address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase());
      },
      allowanceApproved: async () => (await token.allowance(wallet.address, PERMIT2_ADDRESS) as bigint) >= limit,
      approveChecker: () => client.approveSignatureChecker({ ...base, checker: PERMIT2_ADDRESS }),
      approveAllowance: () => client.approveTokenForPermit2({ ...base, token: U_TOKEN[97].address, amount: limit })
    });
    process.stdout.write(`${JSON.stringify({ event: "altana_x402_authority_resumed", ...result }, null, 2)}\n`);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Altana provision recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
