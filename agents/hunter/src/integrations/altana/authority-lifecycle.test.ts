import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PersistedAltanaSession } from "./session-codec.js";
import { FileAuthorityEvidenceStore, type StoredAuthorityEvidence } from "./authority-evidence-store.js";
import { classifyRevocationRejection, provisionAuthority, resumeProvisionAuthority, revokeAuthority } from "./authority-lifecycle.js";
import { EncryptedAltanaSessionStore } from "./session-store.js";
import { loadActiveAltanaAuthority } from "./authority.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const KEY = `0x${"12".repeat(32)}` as const;
const TX = `0x${"ab".repeat(32)}` as const;
function fixture() {
  let saved: PersistedAltanaSession | undefined;
  let journal: StoredAuthorityEvidence | undefined;
  const record: PersistedAltanaSession = {
    version: 1, signerPrivateKey: KEY,
    authority: {
      authorityId: "lifecycle-test", walletAddress: ADDRESS, sessionPublicKey: KEY, chainId: 97,
      allowedCalls: [{ to: ADDRESS }], spendLimits: [], expiry: 2_000_000_000, status: "active", createdAt: 1
    },
    session: { walletAddress: ADDRESS, publicKey: KEY, expiry: 2_000_000_000, permissions: {} }
  };
  const stores = {
    sessions: {
      async load() { return structuredClone(saved); },
      async save(_id: string, value: PersistedAltanaSession) { saved = structuredClone(value); },
      async delete() { saved = undefined; }
    },
    evidence: {
      async get() { return structuredClone(journal); },
      async save(value: StoredAuthorityEvidence) { journal = structuredClone(value); }
    }
  };
  const confirmed = async () => ({ status: "CONFIRMED", transactionHash: TX });
  const grant = { ...stores, record, grant: confirmed, approveChecker: confirmed, approveAllowance: confirmed };
  const revoke = {
    ...stores, authorityId: record.authority.authorityId,
    revokeChecker: confirmed, revokeAllowance: confirmed, revokeSession: confirmed,
    async negativeTest(): Promise<never> { throw new Error(`key hash ${KEY} is unknown`); }
  };
  return { stores, record, grant, revoke };
}

describe("durable Authority lifecycle", () => {
  it("persists disabled recovery material before grant and activates only after every confirmation", async () => {
    const f = fixture();
    f.grant.grant = async () => {
      assert.equal((await f.stores.sessions.load())?.authority.status, "invalid");
      assert.equal((await f.stores.evidence.get())?.lifecycle?.pendingStep, "grantSession");
      return { status: "CONFIRMED", transactionHash: TX };
    };
    const result = await provisionAuthority(f.grant);
    assert.equal(result.authority.status, "active");
    assert.equal(Object.keys(result.lifecycle!.transactions).length, 3);
    assert.equal((await f.stores.sessions.load())?.authority.grantTxHash, TX);
    await assert.rejects(() => provisionAuthority(f.grant), /already exists/);
  });

  it("retains the signer and unknown-step journal if relay response disappears after grant", async () => {
    const f = fixture();
    f.grant.grant = async () => { throw new Error("fetch failed: sensitive-payload"); };
    await assert.rejects(() => provisionAuthority(f.grant), /grantSession did not complete/);
    assert.equal((await f.stores.sessions.load())?.authority.status, "invalid");
    const journal = await f.stores.evidence.get();
    assert.equal(journal?.lifecycle?.phase, "blocked");
    assert.equal(JSON.stringify(journal).includes("sensitive-payload"), false);
  });

  it("rejects unconfirmed grants without enabling spending", async () => {
    const f = fixture();
    f.grant.grant = async () => ({ status: "PENDING", transactionHash: TX });
    await assert.rejects(() => provisionAuthority(f.grant), /did not complete/);
    assert.equal((await f.stores.sessions.load())?.authority.status, "invalid");
  });

  it("resumes a confirmed grant only after reconciling response-lost approval state", async () => {
    const f = fixture();
    let checkerCalls = 0;
    f.grant.approveChecker = async () => { throw new Error("response lost"); };
    await assert.rejects(() => provisionAuthority(f.grant), /approveChecker did not complete/);
    const result = await resumeProvisionAuthority({
      ...f.stores,
      authorityId: f.record.authority.authorityId,
      checkerApproved: async () => true,
      allowanceApproved: async () => false,
      approveChecker: async () => { checkerCalls += 1; return { status: "CONFIRMED", transactionHash: TX }; },
      approveAllowance: async () => ({ status: "CONFIRMED", transactionHash: TX })
    });
    assert.equal(checkerCalls, 0);
    assert.equal(result.lifecycle?.reconciled?.approveChecker?.evidence, "onchain-state");
    assert.equal(result.lifecycle?.transactions.approveAllowance, TX);
    assert.equal((await f.stores.sessions.load())?.authority.status, "active");
  });

  it("fails closed on partial revoke and resumes without repeating confirmed steps", async () => {
    const f = fixture();
    await provisionAuthority(f.grant);
    let checkerCalls = 0;
    f.revoke.revokeChecker = async () => {
      checkerCalls++;
      assert.equal((await f.stores.sessions.load())?.authority.status, "invalid");
      return { status: "CONFIRMED", transactionHash: TX };
    };
    const allowance = f.revoke.revokeAllowance;
    f.revoke.revokeAllowance = async () => { throw new Error("relay timeout"); };
    await assert.rejects(() => revokeAuthority(f.revoke), /revokeAllowance did not complete/);
    assert.equal((await f.stores.sessions.load())?.authority.status, "invalid");
    assert.equal((await f.stores.evidence.get())?.lifecycle?.transactions.revokeChecker, TX);
    f.revoke.revokeAllowance = allowance;
    const result = await revokeAuthority(f.revoke);
    assert.equal(checkerCalls, 1);
    assert.equal(result.revocation?.negativeTest?.outcome, "rejected");
    assert.equal(result.revocation?.sessionMaterialDeleted, true);
    assert.equal(await f.stores.sessions.load(), undefined);
    await revokeAuthority(f.revoke);
    assert.equal(checkerCalls, 1);
  });

  it("does not certify network failure as revocation and retains a disabled key", async () => {
    const f = fixture();
    await provisionAuthority(f.grant);
    f.revoke.negativeTest = async () => { throw new Error("fetch failed"); };
    await assert.rejects(() => revokeAuthority(f.revoke), /not proven rejected/);
    assert.equal((await f.stores.evidence.get())?.revocation?.negativeTest?.outcome, "inconclusive");
    assert.equal((await f.stores.sessions.load())?.authority.status, "revoked");
  });

  it("does not retry a negative test that returned a pending transaction", async () => {
    const f = fixture();
    await provisionAuthority(f.grant);
    let calls = 0;
    const input = { ...f.revoke, negativeTest: async () => {
      calls++;
      return { status: "PENDING", transactionHash: TX };
    } };
    await assert.rejects(() => revokeAuthority(input), /not proven rejected/);
    await assert.rejects(() => revokeAuthority(input), /reconcile it/);
    assert.equal(calls, 1);
  });

  it("only recognizes explicit revoked-key rejections", () => {
    for (const message of ["execution reverted", "insufficient balance", "session expired", "503 unknown session key", "network timeout"]) {
      assert.equal(classifyRevocationRejection(new Error(message)), false, message);
    }
    assert.equal(classifyRevocationRejection(new Error(`key hash ${KEY} is unknown`)), true);
    const realHash = '0x38a58f0d8607c860802d44101dd8a08f7452710e962dfd70b14893e082e50289';
    assert.equal(classifyRevocationRejection(new Error(`URL: https://testnet-relay.altana.network/\nDetails: key hash ${realHash} is unknown`)), true);
    assert.equal(classifyRevocationRejection(new Error(`HTTP 502\nkey hash ${realHash} is unknown`)), false);
    assert.equal(classifyRevocationRejection(new Error(`network timeout\nkey hash ${realHash} is unknown`)), false);
  });

  it("refuses stale active encrypted state when public evidence is revoked or missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-authority-"));
    try {
      const input = { authorityId: "lifecycle-test", storePath: path.join(directory, "session.json"),
        encryptionKey: "ab".repeat(32), evidencePath: path.join(directory, "evidence.json") };
      const f = fixture();
      const sessions = new EncryptedAltanaSessionStore(input.storePath, input.encryptionKey);
      await sessions.save(input.authorityId, f.record);
      await assert.rejects(() => loadActiveAltanaAuthority(input), /not active/);
      const evidence = new FileAuthorityEvidenceStore(input.evidencePath);
      await evidence.save({ authority: { ...f.record.authority, status: "revoked" }, updatedAt: 1 });
      await assert.rejects(() => loadActiveAltanaAuthority(input), /not active/);
      await evidence.save({ authority: f.record.authority, updatedAt: 2 });
      assert.equal((await loadActiveAltanaAuthority(input)).authority.status, "active");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
