import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServiceInfo } from "./types.js";
import { listDynamicServices, registerDynamicService } from "./dynamic-service-store.js";

function service(index: number): ServiceInfo {
  return {
    id: `service-${index}`,
    name: `Service ${index}`,
    description: "concurrency test",
    endpoint: `http://localhost:${4000 + index}`,
    taskType: "finding-verification",
    price: "1",
    currency: "tBNB",
    network: "eip155:97",
    provider: `0x${index.toString(16).padStart(40, "0")}`
  };
}

test("serializes concurrent registrations and keeps the JSON store valid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-dynamic-store-test-"));
  const previousPath = process.env.DYNAMIC_REGISTRY_PATH;
  process.env.DYNAMIC_REGISTRY_PATH = path.join(directory, "services.json");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        registerDynamicService({
          agentId: `agent-${index}`,
          service: service(index),
          ttlSeconds: 120
        })
      )
    );
    const services = await listDynamicServices();
    assert.equal(services.length, 12);
    const raw = await readFile(process.env.DYNAMIC_REGISTRY_PATH, "utf8");
    assert.equal(JSON.parse(raw).services.length, 12);
  } finally {
    if (previousPath === undefined) {
      delete process.env.DYNAMIC_REGISTRY_PATH;
    } else {
      process.env.DYNAMIC_REGISTRY_PATH = previousPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("quarantines a corrupt registry instead of crashing every service profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-dynamic-store-corrupt-test-"));
  const previousPath = process.env.DYNAMIC_REGISTRY_PATH;
  process.env.DYNAMIC_REGISTRY_PATH = path.join(directory, "services.json");
  try {
    await writeFile(process.env.DYNAMIC_REGISTRY_PATH, "{}{}", "utf8");
    await registerDynamicService({ agentId: "agent-1", service: service(1), ttlSeconds: 120 });
    assert.equal((await listDynamicServices()).length, 1);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith("services.json.corrupt.")),
      true
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.DYNAMIC_REGISTRY_PATH;
    } else {
      process.env.DYNAMIC_REGISTRY_PATH = previousPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
