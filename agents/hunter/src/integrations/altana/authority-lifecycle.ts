import type { HexAddress, HexHash } from "@rebel/shared";
import type {
  AuthorityLifecycleStep, AuthorityNegativeTestEvidence, StoredAuthorityEvidence
} from "./authority-evidence-store.js";
import type { PersistedAltanaSession } from "./session-codec.js";

type TransactionResult = { status?: string; transactionHash?: string };
interface Stores {
  sessions: {
    load(id: string): Promise<PersistedAltanaSession | undefined>;
    save(id: string, record: PersistedAltanaSession): Promise<void>;
    delete(id: string): Promise<void>;
  };
  evidence: {
    get(id: string): Promise<StoredAuthorityEvidence | undefined>;
    save(record: StoredAuthorityEvidence): Promise<void>;
  };
}

function confirmed(label: string, result: TransactionResult): HexHash {
  if ((result.status && result.status !== "CONFIRMED") ||
      !result.transactionHash || !/^0x[\da-f]{64}$/i.test(result.transactionHash)) {
    throw new Error(`${label} is not confirmed; inspect the lifecycle journal before proceeding`);
  }
  return result.transactionHash as HexHash;
}

async function checkpoint(
  evidence: StoredAuthorityEvidence, stores: Stores, step: AuthorityLifecycleStep,
  send: () => Promise<TransactionResult>
): Promise<HexHash> {
  const progress = evidence.lifecycle!;
  const previous = progress.transactions[step];
  if (previous) return previous;
  progress.pendingStep = step;
  progress.phase = "in-progress";
  evidence.updatedAt = Math.floor(Date.now() / 1000);
  await stores.evidence.save(evidence); // Durable intent before any broadcast.
  try {
    const tx = confirmed(step, await send());
    progress.transactions[step] = tx;
    delete progress.pendingStep;
    await stores.evidence.save(evidence);
    return tx;
  } catch {
    progress.phase = "blocked";
    await stores.evidence.save(evidence);
    // Do not persist raw relay errors: they may include signed payloads or URL credentials.
    throw new Error(`${step} did not complete. Authority is disabled locally; recovery material and confirmed steps were retained.`);
  }
}

/** Caller must hold the lifecycle lock for this store; never auto-regrant an existing ID. */
export async function provisionAuthority(input: Stores & {
  record: PersistedAltanaSession;
  grant(): Promise<TransactionResult>;
  approveChecker(): Promise<TransactionResult>;
  approveAllowance(): Promise<TransactionResult>;
}): Promise<StoredAuthorityEvidence> {
  const id = input.record.authority.authorityId;
  if (await input.sessions.load(id) || await input.evidence.get(id)) {
    throw new Error("Authority ID already exists; reconcile/revoke it before creating a new authority");
  }
  const record = structuredClone(input.record);
  record.authority.status = "invalid";
  const evidence: StoredAuthorityEvidence = {
    authority: record.authority,
    lifecycle: { operation: "provision", phase: "in-progress", transactions: {} },
    updatedAt: Math.floor(Date.now() / 1000)
  };
  await input.sessions.save(id, record); // Preserve the key even if SDK throws after broadcasting grant.
  await input.evidence.save(evidence);
  record.authority.grantTxHash = await checkpoint(evidence, input, "grantSession", input.grant);
  await input.sessions.save(id, record);
  await checkpoint(evidence, input, "approveChecker", input.approveChecker);
  await checkpoint(evidence, input, "approveAllowance", input.approveAllowance);
  record.authority.status = "active";
  evidence.lifecycle!.phase = "complete";
  await input.evidence.save(evidence);
  await input.sessions.save(id, record);
  return evidence;
}

/** Resume only after read-only state checks resolve any response-lost step. */
export async function resumeProvisionAuthority(input: Stores & {
  authorityId: string;
  checkerApproved(): Promise<boolean>;
  allowanceApproved(): Promise<boolean>;
  approveChecker(): Promise<TransactionResult>;
  approveAllowance(): Promise<TransactionResult>;
}): Promise<StoredAuthorityEvidence> {
  const record = await input.sessions.load(input.authorityId);
  const evidence = await input.evidence.get(input.authorityId);
  if (!record || !evidence || evidence.lifecycle?.operation !== "provision") {
    throw new Error(`Provision recovery material not found: ${input.authorityId}`);
  }
  if (record.authority.status !== "invalid" || evidence.lifecycle.phase === "complete") {
    throw new Error("Only an incomplete disabled provision can be resumed");
  }
  if (!evidence.lifecycle.transactions.grantSession || !record.authority.grantTxHash) {
    throw new Error("Grant confirmation is missing; do not resume automatically");
  }
  evidence.lifecycle.reconciled ??= {};
  if (!evidence.lifecycle.transactions.approveChecker) {
    if (await input.checkerApproved()) {
      evidence.lifecycle.reconciled.approveChecker = { checkedAt: Date.now(), evidence: "onchain-state" };
      delete evidence.lifecycle.pendingStep;
      await input.evidence.save(evidence);
    } else {
      await checkpoint(evidence, input, "approveChecker", input.approveChecker);
    }
  }
  if (!evidence.lifecycle.transactions.approveAllowance) {
    if (await input.allowanceApproved()) {
      evidence.lifecycle.reconciled.approveAllowance = { checkedAt: Date.now(), evidence: "onchain-state" };
      delete evidence.lifecycle.pendingStep;
      await input.evidence.save(evidence);
    } else {
      await checkpoint(evidence, input, "approveAllowance", input.approveAllowance);
    }
  }
  record.authority.status = "active";
  evidence.authority = record.authority;
  evidence.lifecycle.phase = "complete";
  delete evidence.lifecycle.pendingStep;
  await input.evidence.save(evidence);
  await input.sessions.save(input.authorityId, record);
  return evidence;
}

export function classifyRevocationRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // RPC messages include URLs and key hashes. A hash containing "502" or a
  // .network hostname is not evidence of a transport failure.
  const diagnostic = message.replace(/https?:\/\/\S+/gi, '').replace(/0x[\da-f]+/gi, '');
  if (/timeout|timed out|\bnetwork\b|fetch failed|ECONN|ENOTFOUND|rate limit|\b(?:429|502|503|504)\b/i.test(diagnostic)) return false;
  // Expired keys, insufficient funds and generic reverted transactions do not prove revocation.
  return /key hash\s+0x[\da-f]+\s+is unknown/i.test(message) ||
    /(?:session key (?:is |was )?(?:revoked|unknown)|(?:unknown|revoked) session key)/i.test(message);
}

/** Confirmed cleanup steps are resumable; disabling operations are safe to retry, grants are not. */
export async function revokeAuthority(input: Stores & {
  authorityId: string;
  revokeChecker(): Promise<TransactionResult>;
  revokeAllowance(): Promise<TransactionResult>;
  revokeSession(): Promise<TransactionResult>;
  negativeTest(recipient: HexAddress): Promise<TransactionResult>;
}): Promise<StoredAuthorityEvidence> {
  const id = input.authorityId;
  const record = await input.sessions.load(id);
  let evidence = await input.evidence.get(id);
  if (!record) {
    if (evidence?.authority.status === "revoked" && evidence.revocation?.negativeTest?.rejected) {
      evidence.revocation.sessionMaterialDeleted = true;
      await input.evidence.save(evidence);
      return evidence;
    }
    throw new Error(`Authority recovery material not found: ${id}`);
  }
  if (record.authority.chainId !== 97) throw new Error("Revoke requires a BNB Testnet authority");
  record.authority.status = "invalid";
  await input.sessions.save(id, record); // Fail closed BEFORE the first revocation transaction.
  const prior = evidence?.lifecycle?.operation === "revoke" ? evidence.lifecycle : undefined;
  evidence = {
    ...evidence,
    authority: record.authority,
    lifecycle: prior ?? { operation: "revoke", phase: "in-progress", transactions: {} },
    updatedAt: Math.floor(Date.now() / 1000)
  };
  // Old fully-revoked evidence predates lifecycle checkpoints. Do not rebroadcast those steps.
  if (evidence.revocation) Object.assign(evidence.lifecycle!.transactions, {
    revokeChecker: evidence.revocation.checkerApprovalTxHash,
    revokeAllowance: evidence.revocation.permit2AllowanceTxHash,
    revokeSession: evidence.revocation.sessionRevokeTxHash
  });
  await input.evidence.save(evidence);
  const checkerApprovalTxHash = await checkpoint(evidence, input, "revokeChecker", input.revokeChecker);
  const permit2AllowanceTxHash = await checkpoint(evidence, input, "revokeAllowance", input.revokeAllowance);
  const sessionRevokeTxHash = await checkpoint(evidence, input, "revokeSession", input.revokeSession);
  record.authority.status = "revoked";
  record.authority.revokeTxHash = sessionRevokeTxHash;
  evidence.revocation = {
    checkerApprovalTxHash, permit2AllowanceTxHash, sessionRevokeTxHash,
    negativeTest: evidence.revocation?.negativeTest, sessionMaterialDeleted: false
  };
  await input.sessions.save(id, record);
  await input.evidence.save(evidence);

  if (!evidence.revocation.negativeTest?.rejected) {
    if (evidence.revocation.negativeTest?.unexpectedTxHash) {
      throw new Error("Previous negative test returned a transaction; reconcile it before any further test");
    }
    const recipient = record.authority.allowedCalls[0]?.to;
    if (!recipient) throw new Error("Authority has no recipient for the negative test");
    const test: AuthorityNegativeTestEvidence = {
      kind: "erc20-transfer", recipient, amount: "1", testedAt: Math.floor(Date.now() / 1000),
      rejected: false, outcome: "inconclusive"
    };
    try {
      const result = await input.negativeTest(recipient);
      if (result.transactionHash && /^0x[\da-f]{64}$/i.test(result.transactionHash)) {
        test.unexpectedTxHash = result.transactionHash as HexHash;
      }
      if (result.status === "CONFIRMED") test.outcome = "unexpected-success";
      test.rejection = result.status === "CONFIRMED" ? "Transfer unexpectedly confirmed" : "Transaction outcome is inconclusive";
    } catch (error) {
      test.rejected = classifyRevocationRejection(error);
      test.outcome = test.rejected ? "rejected" : "inconclusive";
      test.rejection = test.rejected ? "Relay explicitly rejected the revoked session key" : "No explicit revoked-key rejection; inspect relay/chain before retrying";
    }
    evidence.revocation.negativeTest = test;
    evidence.lifecycle!.phase = test.rejected ? "complete" : "blocked";
    await input.evidence.save(evidence);
    if (!test.rejected) throw new Error("Negative test is not proven rejected; disabled recovery material was retained");
  }
  await input.sessions.delete(id);
  evidence.revocation.sessionMaterialDeleted = true;
  evidence.lifecycle!.phase = "complete";
  evidence.updatedAt = Math.floor(Date.now() / 1000);
  await input.evidence.save(evidence);
  return evidence;
}
