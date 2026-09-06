import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthorityRecord } from "@rebel/shared";
import { readAuthoritySpending, summarizeAuthorityTransfers } from "./authority-spending.js";

const ASSET = {
  chainId: 97,
  kind: "erc20" as const,
  address: "0x2222222222222222222222222222222222222222" as const,
  symbol: "U",
  decimals: 18
};

test("derives daily authority spend and remaining amount from confirmed transfer evidence", () => {
  const now = 2 * 86_400 + 100;
  const summary = summarizeAuthorityTransfers({
    asset: ASSET,
    period: "day",
    limit: "200",
    now,
    transfers: [
      {
        txHash: `0x${"11".repeat(32)}`,
        blockNumber: 1,
        timestamp: 86_400 + 100,
        recipient: "0x3333333333333333333333333333333333333333",
        amount: 75n
      },
      {
        txHash: `0x${"22".repeat(32)}`,
        blockNumber: 2,
        timestamp: 2 * 86_400 + 50,
        recipient: "0x4444444444444444444444444444444444444444",
        amount: 50n
      }
    ]
  });

  assert.equal(summary.spent, "50");
  assert.equal(summary.remaining, "150");
  assert.equal(summary.transactions.length, 1);
});

test("clamps remaining authority spend at zero", () => {
  const summary = summarizeAuthorityTransfers({
    asset: ASSET,
    period: "total",
    limit: "100",
    now: 1,
    transfers: [
      {
        txHash: `0x${"33".repeat(32)}`,
        blockNumber: 1,
        timestamp: 1,
        recipient: "0x3333333333333333333333333333333333333333",
        amount: 120n
      }
    ]
  });

  assert.equal(summary.spent, "120");
  assert.equal(summary.remaining, "0");
});

test("aggregates confirmed x402 receipts without requiring an RPC read", async (context) => {
  const authorityStartedAt = 1_788_360_000;
  const directory = await mkdtemp(path.join(tmpdir(), "agora-authority-spend-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "receipts.json");
  const authority: AuthorityRecord = {
    authorityId: "test-authority",
    walletAddress: "0x1111111111111111111111111111111111111111",
    sessionPublicKey: "0x5555555555555555555555555555555555555555",
    chainId: 97,
    allowedCalls: [{ to: "0x3333333333333333333333333333333333333333" }],
    spendLimits: [{ asset: ASSET, limit: "200", period: "day" }],
    expiry: 999_999,
    status: "active",
    grantTxHash: `0x${"66".repeat(32)}`,
    createdAt: authorityStartedAt * 1_000
  };
  await writeFile(storePath, JSON.stringify({
    version: 1,
    records: {
      valid: {
        serviceId: "auditor-v1",
        updatedAt: authorityStartedAt + 10,
        payment: {
          status: "payment-completed",
          rail: "x402",
          transaction: `0x${"44".repeat(32)}`,
          payer: authority.walletAddress,
          recipient: authority.allowedCalls[0].to,
          amount: { asset: ASSET, amount: "75" }
        }
      },
      beforeAuthority: {
        updatedAt: authorityStartedAt - 100,
        payment: {
          status: "payment-completed",
          rail: "x402",
          transaction: `0x${"77".repeat(32)}`,
          payer: authority.walletAddress,
          recipient: authority.allowedCalls[0].to,
          amount: { asset: ASSET, amount: "50" }
        }
      },
      afterEvidenceWindow: {
        updatedAt: authorityStartedAt + 200,
        payment: {
          status: "payment-completed",
          rail: "x402",
          transaction: `0x${"88".repeat(32)}`,
          payer: authority.walletAddress,
          recipient: authority.allowedCalls[0].to,
          amount: { asset: ASSET, amount: "50" }
        }
      },
      wrongRecipient: {
        updatedAt: authorityStartedAt + 20,
        payment: {
          status: "payment-completed",
          rail: "x402",
          transaction: `0x${"55".repeat(32)}`,
          payer: authority.walletAddress,
          recipient: "0x4444444444444444444444444444444444444444",
          amount: { asset: ASSET, amount: "100" }
        }
      }
    }
  }), "utf8");

  const summaries = await readAuthoritySpending({
    authority,
    rpcUrl: "http://rpc-must-not-be-called.invalid",
    receiptStorePaths: [storePath],
    receiptEvidenceOnly: true,
    receiptEvidenceEnd: authorityStartedAt + 100,
    now: authorityStartedAt + 100
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].evidenceSource, "x402-receipt-store");
  assert.equal(summaries[0].spent, "75");
  assert.equal(summaries[0].remaining, "125");
  assert.equal(summaries[0].transactions.length, 1);
  assert.equal(summaries[0].transactions[0].serviceId, "auditor-v1");
});
