import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import type { AuthorityRecord } from "@rebel/shared";
import { createPersistedAltanaSession, restoreAltanaSession } from "./session-codec.js";
import { EncryptedAltanaSessionStore } from "./session-store.js";

const PRIVATE_KEY = `0x${"01".repeat(32)}` as `0x${string}`;
const WALLET = "0x0000000000000000000000000000000000000001" as const;
const RECIPIENT = "0x0000000000000000000000000000000000000002" as const;
const TBNB = { chainId: 97, kind: "native" as const, symbol: "tBNB", decimals: 18 };

function fixture() {
  const signer = signerFromPrivateKey(PRIVATE_KEY);
  const session: Session = {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {
      calls: [{ to: RECIPIENT }],
      spend: [{ limit: BigInt(10), period: "day" }]
    },
    expiry: 2_000_000_000
  };
  const authority: AuthorityRecord = {
    authorityId: "authority-test",
    walletAddress: WALLET,
    sessionPublicKey: signer.publicKey,
    chainId: 97,
    allowedCalls: [{ to: RECIPIENT }],
    spendLimits: [{ asset: TBNB, limit: "10", period: "day" }],
    expiry: session.expiry,
    status: "active",
    createdAt: 1_900_000_000
  };
  return createPersistedAltanaSession({ authority, session, signerPrivateKey: PRIVATE_KEY });
}

describe("Altana session persistence", () => {
  it("round-trips bigint permissions and signer identity", () => {
    const record = fixture();
    assert.equal(record.session.permissions.spend?.[0]?.limit, "10");
    const restored = restoreAltanaSession(record);
    assert.equal(restored.publicKey, record.session.publicKey);
    assert.equal(restored.permissions.spend?.[0]?.limit, BigInt(10));
  });

  it("encrypts records at rest and supports deletion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-altana-store-"));
    const storePath = path.join(directory, "sessions.json");
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    try {
      const store = new EncryptedAltanaSessionStore(storePath, encryptionKey);
      await store.save("authority-test", fixture());

      const raw = await readFile(storePath, "utf8");
      assert.equal(raw.includes(PRIVATE_KEY), false);
      assert.equal(raw.includes("signerPrivateKey"), false);

      const restored = await store.load("authority-test");
      assert.equal(restored?.authority.authorityId, "authority-test");

      await store.delete("authority-test");
      assert.equal(await store.load("authority-test"), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects weak encryption key material", () => {
    assert.throws(
      () => new EncryptedAltanaSessionStore("/tmp/unused", "too-short"),
      /must be 32-byte/
    );
  });

  it("preserves concurrent sessions across multiple store instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-session-concurrency-"));
    try {
      const file = path.join(directory, "sessions.json");
      const a = new EncryptedAltanaSessionStore(file, "ab".repeat(32));
      const b = new EncryptedAltanaSessionStore(file, "ab".repeat(32));
      await Promise.all(Array.from({ length: 8 }, (_, i) => {
        const record = fixture();
        record.authority.authorityId = String(i);
        return (i % 2 ? a : b).save(String(i), record);
      }));
      for (let i = 0; i < 8; i++) assert.equal((await a.load(String(i)))?.authority.authorityId, String(i));
      await Promise.all([a.delete("0"), b.delete("1")]);
      assert.equal(await a.load("0"), undefined);
      assert.ok(await b.load("2"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
