import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SlitherStatus {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface SlitherRuntime {
  executable: string;
  env: NodeJS.ProcessEnv;
}

interface CachedSlitherStatus {
  executable: string;
  status: SlitherStatus;
}

let cachedStatus: CachedSlitherStatus | undefined;

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function localSlitherExecutable(root: string): string {
  return process.platform === "win32"
    ? path.join(root, ".venv-slither", "Scripts", "slither.exe")
    : path.join(root, ".venv-slither", "bin", "slither");
}

export function getSlitherRuntime(): SlitherRuntime {
  const root = repositoryRoot();
  const configured = process.env.SLITHER_BIN?.trim();
  const executable = configured
    ? path.isAbsolute(configured)
      ? configured
      : path.resolve(process.env.INIT_CWD?.trim() || root, configured)
    : existsSync(localSlitherExecutable(root))
      ? localSlitherExecutable(root)
      : "slither";
  const env = { ...process.env };

  if (path.isAbsolute(executable)) {
    const binDirectory = path.dirname(executable);
    env.PATH = [binDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);
    const possibleVirtualEnv = path.dirname(binDirectory);
    if (existsSync(path.join(possibleVirtualEnv, "pyvenv.cfg"))) {
      env.VIRTUAL_ENV = possibleVirtualEnv;
    }
  }

  return { executable, env };
}

export function getSlitherStatus(): SlitherStatus {
  const runtime = getSlitherRuntime();
  if (cachedStatus?.executable === runtime.executable) {
    return cachedStatus.status;
  }
  const result = spawnSync(runtime.executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: runtime.env,
    windowsHide: true
  });
  if (result.error) {
    const status = {
      available: false,
      reason: result.error.message
    };
    cachedStatus = { executable: runtime.executable, status };
    return status;
  }
  if (result.status !== 0) {
    const status = {
      available: false,
      reason: (result.stderr || `slither exited with status ${String(result.status)}`).trim()
    };
    cachedStatus = { executable: runtime.executable, status };
    return status;
  }
  const status = {
    available: true,
    version: (result.stdout || result.stderr).trim() || "unknown"
  };
  cachedStatus = { executable: runtime.executable, status };
  return status;
}
