import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FileX402ExecutionStore, type StoredX402Execution } from "./receipt-store.js";

test("separate store instances atomically claim one settlement and preserve unrelated writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-settlement-"));
  try {
    const file = path.join(directory, "receipts.json");
    const a = new FileX402ExecutionStore(file);
    const b = new FileX402ExecutionStore(file);
    const record: StoredX402Execution = {
      idempotencyKey: "same", requestHash: "hash", serviceId: "test", updatedAt: 1,
      settlement: { state: "attempting", startedAt: 1 }
    };
    const claims = await Promise.all([a.beginSettlement(record), b.beginSettlement(record)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await new FileX402ExecutionStore(file).get("same"))?.settlement?.state, "attempting");
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).save({ ...record, idempotencyKey: String(i) })));
    for (let i = 0; i < 12; i++) assert.ok(await a.get(String(i)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
