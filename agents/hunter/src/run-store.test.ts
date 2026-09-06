import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HunterError } from "./errors.js";
import { HunterRunManager } from "./run-manager.js";
import { FileHunterRunStore, publicRunRecord } from "./run-store.js";
import type { HunterRunResult } from "./run-types.js";

const fakeResult = (missionId: string): HunterRunResult => ({
  missionId,
  goal: "audit",
  mode: "scripted",
  service: {} as HunterRunResult["service"],
  quote: {} as HunterRunResult["quote"],
  paymentTx: "0xtest",
  execution: {} as HunterRunResult["execution"],
  receiptVerified: true,
  evaluation: { score: 10, summary: "ok" },
  finalMessage: "done"
});

describe("durable Hunter run admission", () => {
  it("atomically deduplicates across store instances and rejects changed input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-run-store-"));
    try {
      const file = path.join(directory, "runs.json");
      const stores = [new FileHunterRunStore(file), new FileHunterRunStore(file)];
      const input = { idempotencyKey: "client:test:1234", ownerId: "owner", goal: "audit", requestMode: "single" as const, locale: "en-US" as const };
      const results = await Promise.all(stores.map((store) => store.admit(input)));
      assert.deepEqual(results.map((item) => item.kind).sort(), ["created", "replay"]);
      assert.equal(results[0].record.missionId, results[1].record.missionId);
      const conflict = await stores[0].admit({ ...input, goal: "different" });
      assert.equal(conflict.kind, "conflict");
      assert.deepEqual(Object.keys(publicRunRecord(results[0].record)).includes("idempotencyHash"), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists admission before execution and always injects the admitted mission id", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-run-manager-"));
    try {
      const store = new FileHunterRunStore(path.join(directory, "runs.json"));
      let seenMission = "";
      const manager = new HunterRunManager(store, async (_goal, options) => {
        const admitted = await store.get(options.missionId!);
        assert.equal(admitted?.status, "running");
        seenMission = options.missionId!;
        options.onEvent?.({ type: "run_started", at: new Date().toISOString(), data: { missionId: seenMission } });
        return fakeResult(seenMission);
      }, async () => undefined);
      const submitted = await manager.submit({ idempotencyKey: "client:test:5678", goal: "audit", requestMode: "single", locale: "en-US" });
      const terminal = await manager.wait(submitted.admission.record.missionId);
      assert.equal(seenMission, submitted.admission.record.missionId);
      assert.equal(terminal?.status, "completed");
      assert.equal(terminal?.events.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not restart an admitted run after process replacement and supports explicit cancellation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-run-recovery-"));
    try {
      const store = new FileHunterRunStore(path.join(directory, "runs.json"));
      let executions = 0;
      const manager = new HunterRunManager(store, async (_goal, options) => {
        executions += 1;
        await new Promise<void>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(
          new HunterError(409, "ABORTED", "aborted")
        ), { once: true }));
        throw new Error("unreachable");
      }, async () => undefined);
      const submitted = await manager.submit({ idempotencyKey: "client:test:9012", goal: "audit", requestMode: "single", locale: "en-US" });
      assert.equal((await manager.cancel(submitted.admission.record.missionId)).accepted, true);
      assert.equal((await manager.wait(submitted.admission.record.missionId))?.status, "cancelled");

      const replacement = new HunterRunManager(store, async () => {
        executions += 1;
        return fakeResult("unexpected");
      }, async () => undefined);
      const replay = await replacement.submit({ idempotencyKey: "client:test:9012", goal: "audit", requestMode: "single", locale: "en-US" });
      assert.equal(replay.admission.kind, "replay");
      assert.equal(replay.activeHere, false);
      assert.equal(executions, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a failed paid run to the exact recovered terminal result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-run-reconciled-"));
    try {
      const store = new FileHunterRunStore(path.join(directory, "runs.json"));
      const admitted = await store.admit({
        idempotencyKey: "client:recovery:1234", ownerId: "original-worker", goal: "audit",
        requestMode: "single", locale: "en-US"
      });
      const missionId = admitted.record.missionId;
      await store.update(missionId, (record) => ({
        ...record,
        status: "failed",
        error: { code: "X402_SERVICE_UNREACHABLE", message: "delivery failed" }
      }));
      const recoveryEvent = {
        type: "run_completed" as const,
        at: new Date().toISOString(),
        data: { recovered: true }
      };
      const result = fakeResult(missionId);
      const recovered = await store.completeRecovered(missionId, result, [recoveryEvent]);
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.error, undefined);
      assert.deepEqual(recovered.result, result);
      assert.deepEqual(recovered.events.at(-1), recoveryEvent);
      const replay = await store.completeRecovered(missionId, result, [recoveryEvent]);
      assert.equal(replay.events.length, 1);
      await assert.rejects(
        () => store.completeRecovered(missionId, { ...result, finalMessage: "different" }, []),
        /different result/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
