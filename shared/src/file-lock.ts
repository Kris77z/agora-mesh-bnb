import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Local, cross-process exclusion. Never steal a stale lock: inspect a crashed writer first. */
export async function withLocalFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  const lockPath = `${path.resolve(filePath)}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`File is locked: ${filePath}. Verify no writer is running before removing its .lock directory.`);
      }
      await delay(20);
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
}
