import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceInfo } from "./types.js";
import { getProcessPostgresStore } from "./storage-backend.js";

interface DynamicServiceEntry {
  agentId: string;
  service: ServiceInfo;
  updatedAt: number;
  expiresAt: number;
}

interface DynamicServiceStore {
  services: DynamicServiceEntry[];
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function getDynamicRegistryPath(): string {
  return path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.DYNAMIC_REGISTRY_PATH ?? "./registry/dynamic-services.json"
  );
}

async function readDynamicStore(storePath: string): Promise<DynamicServiceStore> {
  try {
    const content = await readFile(storePath, "utf8");
    const parsed = JSON.parse(content) as DynamicServiceStore;
    if (!Array.isArray(parsed.services)) {
      throw new SyntaxError("Dynamic service store must contain a services array");
    }
    return { services: parsed.services };
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return { services: [] };
    }
    if (error instanceof SyntaxError) {
      const quarantinePath = `${storePath}.corrupt.${Date.now()}.${process.pid}`;
      await rename(storePath, quarantinePath);
      console.warn(`[registry] corrupt dynamic service store moved to ${quarantinePath}`);
      return { services: [] };
    }
    throw error;
  }
}

async function writeDynamicStore(storePath: string, payload: DynamicServiceStore): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(storePath),
    `.${path.basename(storePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, storePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withDynamicStoreLock<T>(operation: (storePath: string) => Promise<T>): Promise<T> {
  const storePath = getDynamicRegistryPath();
  const lockPath = `${storePath}.lock`;
  await mkdir(path.dirname(storePath), { recursive: true });
  const startedAt = Date.now();
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}:${Date.now()}`, "utf8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        throw error;
      }
      const lockAge = await stat(lockPath)
        .then((metadata) => Date.now() - metadata.mtimeMs)
        .catch(() => 0);
      if (lockAge > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for dynamic service store lock: ${lockPath}`);
      }
      await wait(LOCK_RETRY_MS);
    }
  }
  try {
    return await operation(storePath);
  } finally {
    await lockHandle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function registerDynamicService(input: {
  agentId: string;
  service: ServiceInfo;
  ttlSeconds?: number;
}): Promise<void> {
  const postgres = await getProcessPostgresStore(
    `agora-dynamic-registry-${process.env.SERVICE_PROFILE?.trim() || "api"}`
  );
  if (postgres) {
    const ttlSeconds = input.ttlSeconds ?? 120;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
      throw new Error("Service registration TTL must be an integer between 1 and 86400 seconds");
    }
    await postgres.upsertServiceLease({
      serviceId: input.service.id,
      agentId: input.agentId,
      endpoint: input.service.endpoint,
      capability: input.service,
      ttlMs: ttlSeconds * 1_000,
      runtimeAvailable: input.service.availability?.available !== false
    });
    return;
  }
  await withDynamicStoreLock(async (storePath) => {
    const store = await readDynamicStore(storePath);
    const ttlSeconds = input.ttlSeconds ?? 120;
    const now = Math.floor(Date.now() / 1000);
    const nextEntry: DynamicServiceEntry = {
      agentId: input.agentId,
      service: input.service,
      updatedAt: now,
      expiresAt: now + ttlSeconds
    };
    const filtered = store.services.filter(
      (item) => !(item.agentId === input.agentId && item.service.id === input.service.id)
    );
    filtered.push(nextEntry);
    await writeDynamicStore(storePath, { services: filtered });
  });
}

export async function listDynamicServices(): Promise<ServiceInfo[]> {
  const postgres = await getProcessPostgresStore(
    `agora-dynamic-registry-${process.env.SERVICE_PROFILE?.trim() || "api"}`
  );
  if (postgres) {
    return (await postgres.listAvailableServices()).map((item) => item.capability as ServiceInfo);
  }
  return withDynamicStoreLock(async (storePath) => {
    const store = await readDynamicStore(storePath);
    const now = Math.floor(Date.now() / 1000);
    const active = store.services.filter((item) => item.expiresAt >= now);
    if (active.length !== store.services.length) {
      await writeDynamicStore(storePath, { services: active });
    }
    return active.map((item) => item.service);
  });
}
