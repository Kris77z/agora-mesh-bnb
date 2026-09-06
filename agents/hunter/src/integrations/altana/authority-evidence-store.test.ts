import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthorityRecord } from "@rebel/shared";
import { FileAuthorityEvidenceStore } from "./authority-evidence-store.js";

const authority: AuthorityRecord = {
  authorityId: "authority-1",
  walletAddress: "0x1111111111111111111111111111111111111111",
  sessionPublicKey: "0x2222222222222222222222222222222222222222",
  chainId: 97,
  allowedCalls: [{ to: "0x3333333333333333333333333333333333333333" }],
  spendLimits: [{
    asset: {
      chainId: 97,
      kind: "erc20",
      address: "0x4444444444444444444444444444444444444444",
      symbol: "U",
      decimals: 18
    },
    limit: "2000000000000000000",
    period: "day"
  }],
  expiry: 2_000_000_000,
  status: "active",
  createdAt: 1_000
};

test("persists public Authority state and replaces it with revocation evidence", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "authority-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "authorities.json");
  const store = new FileAuthorityEvidenceStore(storePath);

  await store.save({ authority, updatedAt: 1_000 });
  assert.equal((await store.get(authority.authorityId))?.authority.status, "active");

  await store.save({
    authority: { ...authority, status: "revoked", revokeTxHash: `0x${"a".repeat(64)}` },
    revocation: {
      checkerApprovalTxHash: `0x${"b".repeat(64)}`,
      permit2AllowanceTxHash: `0x${"c".repeat(64)}`,
      sessionRevokeTxHash: `0x${"a".repeat(64)}`,
      negativeTest: {
        kind: "erc20-transfer",
        recipient: authority.allowedCalls[0]!.to,
        amount: "1",
        testedAt: 2_000,
        rejected: true,
        rejection: "session rejected"
      },
      sessionMaterialDeleted: true
    },
    updatedAt: 2_000
  });

  const saved = await store.get(authority.authorityId);
  assert.equal(saved?.authority.status, "revoked");
  assert.equal(saved?.revocation?.negativeTest?.rejected, true);
  assert.equal(saved?.revocation?.sessionMaterialDeleted, true);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(storePath, "utf8"), /signerPrivateKey/);
});
