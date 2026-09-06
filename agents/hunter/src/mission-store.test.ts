import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileHunterMissionStore, readMissionIdFromEvents } from "./mission-store.js";

describe("FileHunterMissionStore", () => {
  it("serializes concurrent mission writes and lists newest first", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-mission-store-"));
    try {
      const store = new FileHunterMissionStore(path.join(directory, "missions.json"));
      await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({
        missionId: `mission-${index}`,
        goal: `goal-${index}`,
        chainId: 97,
        mode: "scripted",
        status: "failed",
        source: "live-run",
        events: [],
        error: { message: "expected test failure" },
        createdAt: index,
        completedAt: index
      })));
      assert.equal((await store.list()).length, 8);
      assert.equal((await store.list())[0].missionId, "mission-7");
      assert.equal((await store.get("mission-3"))?.goal, "goal-3");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the public mission id from lifecycle trace data", () => {
    assert.equal(readMissionIdFromEvents([{
      type: "run_started",
      at: new Date(0).toISOString(),
      data: { missionId: "mission-public" }
    }]), "mission-public");
  });

  it("does not lose writes from separate local store instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-mission-store-multi-"));
    try {
      const filePath = path.join(directory, "missions.json");
      const stores = [new FileHunterMissionStore(filePath), new FileHunterMissionStore(filePath)];
      await Promise.all(stores.map((store, index) => store.save({
        missionId: `multi-${index}`,
        goal: "test",
        chainId: 97,
        mode: "scripted",
        status: "failed",
        source: "live-run",
        events: [],
        error: { message: "test" },
        createdAt: index,
        completedAt: index
      })));
      assert.equal((await stores[0].list()).length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
