import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSlitherRuntime, getSlitherStatus } from "./slither-status.js";

interface SlitherSourceMapping {
  lines?: unknown;
  content?: unknown;
  filename_absolute?: unknown;
  filename_relative?: unknown;
  filename_short?: unknown;
}

interface SlitherElement {
  source_mapping?: unknown;
}

interface SlitherDetectorJson {
  check?: unknown;
  impact?: unknown;
  confidence?: unknown;
  description?: unknown;
  elements?: unknown;
}

export interface SlitherDetection {
  id: string;
  title: string;
  line: number;
  lines?: number[];
  file?: string;
  snippet: string;
  note: string;
  keywords: string[];
}

export interface SlitherAnalysisResult {
  ok: boolean;
  available: boolean;
  version?: string;
  detections: SlitherDetection[];
  error?: string;
}

const DETECTOR_KEYWORDS: Array<{ pattern: RegExp; keywords: string[] }> = [
  { pattern: /reentrancy/i, keywords: ["reentrancy", "external call", "state update"] },
  { pattern: /tx-origin/i, keywords: ["tx.origin", "tx origin", "authorization", "authentication"] },
  { pattern: /delegatecall/i, keywords: ["delegatecall", "delegate call"] },
  { pattern: /suicid|selfdestruct/i, keywords: ["selfdestruct", "self destruct", "suicide"] },
  { pattern: /unchecked.*lowlevel|lowlevel.*unchecked/i, keywords: ["unchecked call", "unchecked low-level", "return value", "low level call"] }
];

function compact(value: string, maxLength = 300): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function sanitizeSlitherDescription(value: string): string {
  return value.replace(
    /(?:[A-Za-z]:)?[^()\s]*[/\\]([^/\\()\s]+\.sol)#/g,
    "$1#"
  );
}

function detectorKeywords(check: string): string[] {
  const specific = DETECTOR_KEYWORDS.find((item) => item.pattern.test(check))?.keywords ?? [];
  return [...new Set([check.toLowerCase(), check.replace(/[-_]+/g, " ").toLowerCase(), ...specific])];
}

function readSourceMapping(detector: SlitherDetectorJson): {
  line: number;
  lines: number[];
  file?: string;
  content?: string;
} {
  const elements = Array.isArray(detector.elements) ? (detector.elements as SlitherElement[]) : [];
  let selected: { line: number; lines: number[]; file?: string; content?: string } | undefined;
  for (const element of elements) {
    const mapping = element.source_mapping && typeof element.source_mapping === "object"
      ? (element.source_mapping as SlitherSourceMapping)
      : undefined;
    const lines = Array.isArray(mapping?.lines)
      ? mapping.lines.filter((value): value is number => Number.isInteger(value) && value > 0)
      : [];
    const line = lines[0];
    if (line !== undefined) {
      const absolute = typeof mapping?.filename_absolute === "string"
        ? mapping.filename_absolute.replace(/\\/g, "/")
        : undefined;
      const tempMarker = absolute?.match(/\/agora-slither-[^/]+\/(.+)$/)?.[1];
      const relative = typeof mapping?.filename_relative === "string"
        ? mapping.filename_relative.replace(/\\/g, "/")
        : undefined;
      const short = typeof mapping?.filename_short === "string"
        ? mapping.filename_short.replace(/\\/g, "/")
        : undefined;
      const file = tempMarker ??
        (relative && !relative.startsWith("/") && !relative.split("/").includes("..")
          ? relative
          : short);
      const candidate = {
        line,
        lines,
        ...(file ? { file } : {}),
        ...(typeof mapping?.content === "string" && mapping.content.trim()
          ? { content: mapping.content }
          : {})
      };
      if (!selected || candidate.lines.length < selected.lines.length) {
        selected = candidate;
      }
    }
  }
  return selected ?? { line: 1, lines: [1] };
}

export function parseSlitherJson(raw: string, source: string): SlitherDetection[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Slither JSON output must be an object");
  }
  const root = parsed as Record<string, unknown>;
  if (root.success !== true) {
    throw new Error(typeof root.error === "string" ? root.error : "Slither analysis was unsuccessful");
  }
  const results = root.results && typeof root.results === "object" && !Array.isArray(root.results)
    ? (root.results as Record<string, unknown>)
    : {};
  const detectors = Array.isArray(results.detectors)
    ? (results.detectors as SlitherDetectorJson[])
    : [];
  const sourceLines = source.split(/\r?\n/);
  return detectors
    .filter(
      (detector) =>
        detector.impact !== "Informational" && detector.impact !== "Optimization"
    )
    .map((detector, index) => {
    const check = typeof detector.check === "string" && detector.check.trim()
      ? detector.check.trim()
      : `slither-detector-${index + 1}`;
    const mapping = readSourceMapping(detector);
    const line = mapping.line;
    const description = sanitizeSlitherDescription(
      typeof detector.description === "string" ? detector.description : check
    );
    const impact = typeof detector.impact === "string" ? detector.impact : "Unknown";
    const confidence = typeof detector.confidence === "string" ? detector.confidence : "Unknown";
    return {
      id: check,
      title: check,
      line,
      lines: mapping.lines,
      ...(mapping.file ? { file: mapping.file } : {}),
      snippet: compact(mapping.content ?? sourceLines[line - 1] ?? description, 220),
      note: `${compact(description)} Impact: ${impact}; Slither confidence: ${confidence}.`,
      keywords: detectorKeywords(check)
    };
    });
}

function safeSolidityFileName(sourceName: string): string {
  const base = path.basename(sourceName).replace(/[^A-Za-z0-9_.-]/g, "_");
  return base.toLowerCase().endsWith(".sol") ? base : `${base || "Contract"}.sol`;
}

function safeSourceUnitPath(tempDirectory: string, sourceUnit: string): string {
  const normalized = sourceUnit.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Solidity source unit path: ${sourceUnit}`);
  }
  const segments = normalized.split("/").map((segment) => segment.replace(/[^A-Za-z0-9_.@-]/g, "_"));
  return path.join(tempDirectory, ...segments);
}

function safeSolcRemappings(tempDirectory: string, remappings: readonly string[]): string[] {
  return remappings.map((remapping) => {
    const separator = remapping.indexOf("=");
    if (separator <= 0 || separator === remapping.length - 1) {
      throw new Error(`Unsafe Solidity remapping: ${remapping}`);
    }
    const prefix = remapping.slice(0, separator);
    const target = remapping.slice(separator + 1).replace(/\\/g, "/");
    if (
      !/^[A-Za-z0-9_.@/-]+$/.test(prefix) ||
      !/^[A-Za-z0-9_.@/-]+$/.test(target) ||
      target.startsWith("/") ||
      target.split("/").includes("..")
    ) {
      throw new Error(`Unsafe Solidity remapping: ${remapping}`);
    }
    const absoluteTarget = safeSourceUnitPath(tempDirectory, target);
    return `${prefix}=${absoluteTarget}${target.endsWith("/") ? path.sep : ""}`;
  });
}

export function runSlitherAnalysis(
  source: string,
  sourceName: string,
  sources?: Record<string, string>,
  remappings: readonly string[] = []
): SlitherAnalysisResult {
  const status = getSlitherStatus();
  if (!status.available) {
    return {
      ok: false,
      available: false,
      detections: [],
      error: status.reason ?? "Slither is not installed"
    };
  }
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "agora-slither-"));
  try {
    const runtime = getSlitherRuntime();
    let sourcePath = path.join(tempDirectory, safeSolidityFileName(sourceName));
    if (sources && Object.keys(sources).length > 0) {
      const entries = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
      for (const [sourceUnit, content] of entries) {
        const unitPath = safeSourceUnitPath(tempDirectory, sourceUnit);
        mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
        writeFileSync(unitPath, content, { encoding: "utf8", mode: 0o600 });
      }
      const requestedSourcePath = safeSourceUnitPath(tempDirectory, sourceName);
      sourcePath = sources[sourceName] ? requestedSourcePath : safeSourceUnitPath(tempDirectory, entries[0]![0]);
    } else {
      writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600 });
    }
    const args = [
      sourcePath,
      "--json",
      "-",
      "--disable-color",
      "--solc-disable-warnings",
      "--exclude-informational",
      "--exclude-optimization"
    ];
    if (remappings.length > 0) {
      args.push("--solc-remaps", safeSolcRemappings(tempDirectory, remappings).join(" "));
    }
    const run = () =>
      spawnSync(runtime.executable, args, {
        encoding: "utf8",
        timeout: 45_000,
        maxBuffer: 16 * 1024 * 1024,
        env: runtime.env,
        windowsHide: true
      });
    let execution = run();
    if (!execution.error && !execution.stdout.trim()) {
      execution = run();
    }
    if (execution.error) {
      return {
        ok: false,
        available: true,
        version: status.version,
        detections: [],
        error: execution.error.message
      };
    }
    try {
      if (!execution.stdout.trim()) {
        throw new Error(
          `Slither returned empty JSON output (exit status ${String(execution.status)})`
        );
      }
      return {
        ok: true,
        available: true,
        version: status.version,
        detections: parseSlitherJson(execution.stdout, source)
      };
    } catch (error) {
      return {
        ok: false,
        available: true,
        version: status.version,
        detections: [],
        error:
          execution.stderr.trim() ||
          (error instanceof Error
            ? error.message
            : `Slither exited with status ${String(execution.status)}`)
      };
    }
  } catch (error) {
    return {
      ok: false,
      available: true,
      version: status.version,
      detections: [],
      error: error instanceof Error ? error.message : "Slither source preparation failed"
    };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
