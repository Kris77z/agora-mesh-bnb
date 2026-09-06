import { HunterError } from "../../errors.js";
import { EncryptedAltanaSessionStore } from "./session-store.js";
import { openAuthorityEvidenceStore } from "./authority-evidence-store.js";

export interface LoadAltanaAuthorityInput {
  authorityId: string;
  storePath: string;
  encryptionKey: string;
  evidencePath?: string;
}

export async function loadAltanaAuthority(input: LoadAltanaAuthorityInput) {
  const store = new EncryptedAltanaSessionStore(input.storePath, input.encryptionKey);
  const record = await store.load(input.authorityId);
  if (!record) {
    throw new HunterError(503, "AUTHORITY_NOT_FOUND", `Authority not found: ${input.authorityId}`);
  }
  return record;
}

export async function loadActiveAltanaAuthority(input: LoadAltanaAuthorityInput) {
  const record = await loadAltanaAuthority(input);
  const evidence = input.evidencePath
    ? await (await openAuthorityEvidenceStore(input.evidencePath)).get(input.authorityId)
    : undefined;
  const now = Math.floor(Date.now() / 1000);
  const inconsistent = record.authority.authorityId !== input.authorityId ||
    record.authority.walletAddress.toLowerCase() !== record.session.walletAddress.toLowerCase() ||
    record.authority.sessionPublicKey.toLowerCase() !== record.session.publicKey.toLowerCase() ||
    record.authority.expiry !== record.session.expiry;
  const evidenceInactive = input.evidencePath && (!evidence || evidence.authority.status !== "active" ||
    evidence.authority.sessionPublicKey.toLowerCase() !== record.session.publicKey.toLowerCase() ||
    evidence.lifecycle && (evidence.lifecycle.operation !== "provision" || evidence.lifecycle.phase !== "complete"));
  if (inconsistent || evidenceInactive || record.authority.status !== "active" || record.authority.expiry <= now) {
    throw new HunterError(403, "AUTHORITY_INACTIVE", "Altana authority is not active", {
      authorityId: input.authorityId,
      status: record.authority.status,
      expiry: record.authority.expiry
    });
  }
  return record;
}
