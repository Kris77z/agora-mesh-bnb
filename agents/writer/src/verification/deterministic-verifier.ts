import { createHash } from "node:crypto";
import { z } from "zod";
import type { FindingVerification, SecurityFinding, VerificationReport } from "@rebel/shared";
import {
  runSlitherAnalysis,
  type SlitherAnalysisResult,
  type SlitherDetection
} from "./slither-runner.js";

const securityFindingSchema = z.object({
  findingId: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  description: z.string().min(1),
  evidence: z.object({
    file: z.string().optional(),
    lines: z.string().optional(),
    snippet: z.string().optional(),
    bytecodeOffset: z.string().optional()
  }),
  exploitScenario: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const verificationInputSchema = z.object({
  source: z.string().min(1),
  sourceName: z.string().min(1).default("Contract.sol"),
  sources: z.record(z.string().min(1)).optional(),
  remappings: z.array(z.string().min(1)).optional(),
  findings: z.array(securityFindingSchema)
});

export interface RuleDetection {
  id: string;
  title: string;
  line: number;
  lines?: number[];
  file?: string;
  tool?: string;
  statusHint?: "partial";
  snippet: string;
  note: string;
  keywords: string[];
}

interface FunctionBlock {
  name: string;
  start: number;
  end: number;
  code: string;
}

export type DeterministicVerificationReport = VerificationReport;

function compactSnippet(line: string): string {
  const compact = line.trim().replace(/\s+/g, " ");
  return compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
}

function addDetection(
  target: RuleDetection[],
  detection: RuleDetection
): void {
  if (!target.some((item) => item.id === detection.id && item.line === detection.line)) {
    target.push(detection);
  }
}

function maskComments(source: string): string[] {
  let inBlockComment = false;
  return source.split(/\r?\n/).map((line) => {
    let masked = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      if (inBlockComment) {
        if (line[index] === "*" && line[index + 1] === "/") {
          inBlockComment = false;
          masked += "  ";
          index += 1;
        } else {
          masked += " ";
        }
        continue;
      }
      if (quote) {
        const current = line[index];
        masked += " ";
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === quote) {
          quote = undefined;
        }
        continue;
      }
      if (line[index] === "/" && line[index + 1] === "*") {
        inBlockComment = true;
        masked += "  ";
        index += 1;
        continue;
      }
      if (line[index] === "/" && line[index + 1] === "/") {
        masked += " ".repeat(line.length - index);
        break;
      }
      if (line[index] === '"' || line[index] === "'") {
        quote = line[index] as "'" | '"';
        masked += " ";
        continue;
      }
      masked += line[index];
    }
    return masked;
  });
}

function detectLineRules(lines: string[], sourceLines: string[]): RuleDetection[] {
  const detections: RuleDetection[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/\btx\.origin\b/.test(line)) {
      addDetection(detections, {
        id: "tx-origin",
        title: "tx.origin authorization",
        line: lineNumber,
        snippet: compactSnippet(sourceLines[index] ?? line),
        note: "tx.origin is present and can make authorization depend on the transaction originator.",
        keywords: ["tx.origin", "tx origin", "authorization", "authentication"]
      });
    }
    if (/\.delegatecall\s*(?:\{|\()/.test(line)) {
      addDetection(detections, {
        id: "delegatecall",
        title: "Delegatecall surface",
        line: lineNumber,
        snippet: compactSnippet(sourceLines[index] ?? line),
        note: "delegatecall executes foreign code in the caller's storage context.",
        keywords: ["delegatecall", "delegate call"]
      });
    }
    if (/\b(?:selfdestruct|suicide)\s*\(/.test(line)) {
      addDetection(detections, {
        id: "selfdestruct",
        title: "Self-destruct instruction",
        line: lineNumber,
        snippet: compactSnippet(sourceLines[index] ?? line),
        note: "The source contains an explicit selfdestruct-style instruction.",
        keywords: ["selfdestruct", "self destruct", "suicide"]
      });
    }
    const hasLowLevelCall = /\.call\s*(?:\{|\()/.test(line);
    const checksReturn = /\b(success|ok|sent)\b/.test(line) || /require\s*\(/.test(line);
    if (hasLowLevelCall && !checksReturn) {
      addDetection(detections, {
        id: "unchecked-lowlevel",
        title: "Unchecked low-level call",
        line: lineNumber,
        snippet: compactSnippet(sourceLines[index] ?? line),
        note: "A low-level call appears without a same-statement success check.",
        keywords: ["unchecked call", "unchecked low-level", "return value", "low level call"]
      });
    }
  });
  return detections;
}

function detectReentrancyOrdering(lines: string[], sourceLines: string[]): RuleDetection[] {
  const detections: RuleDetection[] = [];
  let functionStart = -1;
  let depth = 0;
  let functionOpened = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (functionStart < 0 && /\bfunction\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
      functionStart = index;
      depth = 0;
      functionOpened = false;
    }
    if (functionStart < 0) {
      continue;
    }
    const openings = (line.match(/\{/g) ?? []).length;
    depth += openings;
    depth -= (line.match(/\}/g) ?? []).length;
    functionOpened ||= openings > 0;
    if (!functionOpened || depth > 0) {
      continue;
    }
    const block = lines.slice(functionStart, index + 1);
    const externalCallOffset = block.findIndex((item) => /\.call\s*(?:\{|\()/.test(item));
    if (externalCallOffset >= 0) {
      const mutationOffset = block.findIndex(
        (item, offset) =>
          offset > externalCallOffset &&
          /(?:\[[^\]]+\]|\b[A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\+=|-=|\+\+|--)/.test(item) &&
          !/^\s*(?:bool|uint\d*|int\d*|address|string|bytes\d*)\b/.test(item)
      );
      if (mutationOffset >= 0) {
        const callLine = functionStart + externalCallOffset + 1;
        addDetection(detections, {
          id: "reentrancy-ordering",
          title: "External call before state update",
          line: callLine,
          snippet: compactSnippet(sourceLines[functionStart + externalCallOffset] ?? ""),
          note: `An external call at L${callLine} precedes a state-like mutation at L${functionStart + mutationOffset + 1}.`,
          keywords: ["reentrancy", "checks effects interactions", "external call", "state update"]
        });
      }
    }
    functionStart = -1;
    depth = 0;
    functionOpened = false;
  }
  return detections;
}

function extractFunctionBlocks(lines: string[]): FunctionBlock[] {
  const blocks: FunctionBlock[] = [];
  let functionStart = -1;
  let functionName = "";
  let depth = 0;
  let opened = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (functionStart < 0) {
      const match = line.match(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!match) continue;
      functionStart = index;
      functionName = match[1]!;
      depth = 0;
      opened = false;
    }
    const openings = (line.match(/\{/g) ?? []).length;
    depth += openings;
    depth -= (line.match(/\}/g) ?? []).length;
    opened ||= openings > 0;
    if (!opened || depth > 0) continue;
    blocks.push({
      name: functionName,
      start: functionStart,
      end: index,
      code: lines.slice(functionStart, index + 1).join("\n")
    });
    functionStart = -1;
    functionName = "";
    depth = 0;
    opened = false;
  }
  return blocks;
}

function detectPrivilegeAndLifecycleRules(
  lines: string[],
  sourceLines: string[]
): RuleDetection[] {
  const detections: RuleDetection[] = [];
  for (const block of extractFunctionBlocks(lines)) {
    const line = block.start + 1;
    const snippet = compactSnippet(sourceLines[block.start] ?? "");
    const headerEnd = block.code.indexOf("{");
    const header = headerEnd >= 0 ? block.code.slice(0, headerEnd) : block.code;
    if (
      /^initialize[A-Za-z0-9_]*$/.test(block.name) &&
      /\b(?:initializer|reinitializer\s*\()/.test(header) &&
      /\b(?:public|external)\b/.test(header) &&
      !/\b(?:onlyOwner|onlyRole|restricted|requiresAuth)\b/.test(header)
    ) {
      addDetection(detections, {
        id: "unprotected-initializer",
        title: "Externally callable initializer lacks an explicit authorization modifier",
        line,
        lines: Array.from({ length: block.end - block.start + 1 }, (_, index) => line + index),
        snippet,
        note:
          "The initializer/reinitializer is externally callable without an explicit authorization modifier. This confirms the source structure only; exploitability depends on atomic deployment/upgrade execution and current initialization state.",
        keywords: [
          "unprotected initializer",
          "initializer unprotected",
          "initializer can be called by anyone",
          "initializer can be front-run",
          "initializer can be front run",
          "front-runnable v1 initializer",
          "front runnable v1 initializer",
          "force-enabling"
        ],
        tool: "agora-solidity-rules@2",
        statusHint: "partial"
      });
    }
    if (
      /mint/i.test(block.name) &&
      /\bonlyAutoOwner\b/.test(header) &&
      /autoMintMaxLimit\s*>=\s*amount/.test(block.code) &&
      /\b_mint\s*\(/.test(block.code) &&
      !/autoMintMaxLimit\s*(?:-=|=\s*autoMintMaxLimit\s*-)/.test(block.code)
    ) {
      addDetection(detections, {
        id: "per-call-mint-limit",
        title: "Privileged mint limit is checked per call and not consumed",
        line,
        lines: Array.from({ length: block.end - block.start + 1 }, (_, index) => line + index),
        snippet,
        note:
          "The privileged mint path compares one amount to a limit but does not consume or accumulate the limit in the same function. This confirms per-call semantics; whether that violates policy requires documentation and runtime configuration review.",
        keywords: [
          "auto-mint max limit",
          "auto mint max limit",
          "unbounded total minting",
          "unbounded auto mint",
          "cumulative auto-mint",
          "cumulative auto mint",
          "arbitrary inflation"
        ],
        tool: "agora-solidity-rules@2",
        statusHint: "partial"
      });
    }
    if (
      /burn/i.test(block.name) &&
      /\bonlyAutoOwner\b/.test(header) &&
      /address\s+owner\s*=\s*owner\s*\(\s*\)/.test(block.code) &&
      /_burn\s*\(\s*owner\s*,/.test(block.code)
    ) {
      addDetection(detections, {
        id: "cross-role-owner-burn",
        title: "One privileged role burns the owner role's balance",
        line,
        lines: Array.from({ length: block.end - block.start + 1 }, (_, index) => line + index),
        snippet,
        note:
          "A function restricted to autoOwner resolves owner() and burns that address's balance without an allowance check. This confirms the role interaction; its security classification depends on the intended role policy and current role addresses.",
        keywords: [
          "autoburn",
          "auto burn",
          "auto-burn",
          "burns owner balance",
          "owner's balance without allowance",
          "owner balance without allowance"
        ],
        tool: "agora-solidity-rules@2",
        statusHint: "partial"
      });
    }
  }
  return detections;
}

export function detectSolidityRules(source: string, file?: string): RuleDetection[] {
  const sourceLines = source.split(/\r?\n/);
  const lines = maskComments(source);
  return [
    ...detectLineRules(lines, sourceLines),
    ...detectReentrancyOrdering(lines, sourceLines),
    ...detectPrivilegeAndLifecycleRules(lines, sourceLines)
  ]
    .map((detection) => ({
      ...detection,
      ...(file ? { file } : {}),
      tool: detection.tool ?? "agora-solidity-rules@2"
    }))
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

function deduplicateDetections(detections: readonly RuleDetection[]): RuleDetection[] {
  const unique = new Map<string, RuleDetection>();
  for (const detection of detections) {
    const key = `${detection.file ?? ""}:${detection.id}:${detection.line}:${detection.snippet}`;
    if (!unique.has(key)) unique.set(key, detection);
  }
  return [...unique.values()];
}

function findingCategoryText(finding: SecurityFinding): string {
  return [
    finding.findingId,
    finding.title,
    finding.description,
    finding.evidence.snippet ?? ""
  ]
    .join(" ")
    .toLowerCase();
}

function matchesDetection(finding: SecurityFinding, detection: RuleDetection): boolean {
  const haystack = findingCategoryText(finding);
  return detection.keywords.some((keyword) => haystack.includes(keyword));
}

function normalizeSourceUnit(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sourceUnitMatches(finding: SecurityFinding, detection: RuleDetection): boolean {
  if (!finding.evidence.file || !detection.file) return true;
  const cited = normalizeSourceUnit(finding.evidence.file);
  const detected = normalizeSourceUnit(detection.file);
  return cited === detected || cited.endsWith(`/${detected}`) || detected.endsWith(`/${cited}`);
}

function detectionSupportsFinding(
  finding: SecurityFinding,
  detection: RuleDetection
): boolean {
  return matchesDetection(finding, detection) && sourceUnitMatches(finding, detection);
}

function parseEvidenceLines(value: string): Set<number> {
  const lines = new Set<number>();
  for (const match of value.matchAll(/L?(\d+)(?:\s*-\s*L?(\d+))?/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
      continue;
    }
    for (let line = start; line <= Math.min(end, start + 1_000); line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

function verificationForFinding(
  finding: SecurityFinding,
  detections: RuleDetection[],
  verifierAgentId: string,
  method: FindingVerification["method"],
  tool: string
): FindingVerification {
  const citedLines = finding.evidence.lines ?? "";
  const citedLineNumbers = parseEvidenceLines(citedLines);
  const matching = detections
    .filter((detection) => detectionSupportsFinding(finding, detection))
    .sort((left, right) => {
      const leftLines = left.lines ?? [left.line];
      const rightLines = right.lines ?? [right.line];
      const leftOverlap = leftLines.some((line) => citedLineNumbers.has(line));
      const rightOverlap = rightLines.some((line) => citedLineNumbers.has(line));
      return Number(rightOverlap) - Number(leftOverlap) || left.line - right.line;
    });
  const knownCategory = [
    "tx.origin",
    "tx origin",
    "delegatecall",
    "delegate call",
    "selfdestruct",
    "self destruct",
    "unchecked call",
    "unchecked low-level",
    "reentrancy"
  ].some((keyword) => findingCategoryText(finding).includes(keyword));
  const first = matching[0];
  if (!first) {
    return {
      findingId: finding.findingId,
      status: knownCategory ? "rejected" : "inconclusive",
      method,
      confidence: knownCategory ? 0.82 : 0.25,
      evidence: {
        tool,
        note: knownCategory
          ? "The claimed deterministic pattern was not found in the supplied source."
          : "No deterministic rule covers this finding category; no LLM fallback was used."
      },
      verifierAgentId
    };
  }
  const detectorLines = first.lines ?? [first.line];
  const citesDetection = detectorLines.some((line) => citedLineNumbers.has(line));
  const status = first.statusHint ?? (citesDetection || !citedLines ? "confirmed" : "partial");
  return {
    findingId: finding.findingId,
    status,
    method,
    confidence: status === "confirmed" ? 0.92 : first.statusHint ? 0.78 : 0.72,
    evidence: {
      tool: first.tool ?? tool,
      detector: first.id,
      ...(first.file ? { file: first.file } : {}),
      lines: `L${first.line}`,
      snippet: first.snippet,
      note: first.note
    },
    verifierAgentId
  };
}

function missedVerification(
  detection: RuleDetection,
  verifierAgentId: string,
  method: FindingVerification["method"],
  tool: string
): FindingVerification {
  const findingId = `missed-${createHash("sha256")
    .update(`${detection.file ?? ""}:${detection.id}:${detection.line}:${detection.snippet}`)
    .digest("hex")
    .slice(0, 16)}`;
  return {
    findingId,
    status: "missed",
    method,
    confidence: 0.9,
    evidence: {
      tool: detection.tool ?? tool,
      detector: detection.id,
      ...(detection.file ? { file: detection.file } : {}),
      lines: `L${detection.line}`,
      snippet: detection.snippet,
      note: `${detection.note} No supplied auditor finding matched this detector.`
    },
    verifierAgentId
  };
}

export function runDeterministicVerification(
  rawInput: string,
  verifierAgentId: string,
  options: {
    runSlither?: (
      source: string,
      sourceName: string,
      sources?: Record<string, string>,
      remappings?: string[]
    ) => SlitherAnalysisResult;
  } = {}
): DeterministicVerificationReport {
  const input = verificationInputSchema.parse(JSON.parse(rawInput));
  const findings = input.findings as SecurityFinding[];
  const slither = (options.runSlither ?? runSlitherAnalysis)(
    input.source,
    input.sourceName,
    input.sources,
    input.remappings
  );
  const usingSlither = slither.ok;
  const sourceRuleDetections = input.sources
    ? Object.entries(input.sources).flatMap(([file, source]) => detectSolidityRules(source, file))
    : detectSolidityRules(input.source, input.sourceName);
  const detections: RuleDetection[] = deduplicateDetections(usingSlither
    ? [
        ...slither.detections.map((detection: SlitherDetection) => ({ ...detection })),
        ...sourceRuleDetections
      ]
    : sourceRuleDetections);
  const method: FindingVerification["method"] = usingSlither ? "static-analysis" : "ast-rule";
  const tool = usingSlither
    ? `slither${slither.version ? `@${slither.version}` : ""}`
    : "agora-solidity-rules@1";
  const verifications = findings.map((finding) =>
    verificationForFinding(finding, detections, verifierAgentId, method, tool)
  );
  for (const detection of detections) {
    if (!findings.some((finding) => detectionSupportsFinding(finding, detection))) {
      verifications.push(missedVerification(detection, verifierAgentId, method, tool));
    }
  }
  const count = (status: FindingVerification["status"]) =>
    verifications.filter((item) => item.status === status).length;
  return {
    sourceName: input.sourceName,
    sourceHash: `sha256:${createHash("sha256").update(input.source).digest("hex")}`,
    engine: {
      method: usingSlither ? "static-analysis" : "ast-rule",
      name: usingSlither ? "slither" : "agora-solidity-rules",
      version: usingSlither ? slither.version : "1",
      ...(!usingSlither && slither.error ? { fallbackReason: slither.error } : {})
    },
    verifications,
    summary: {
      confirmed: count("confirmed"),
      rejected: count("rejected"),
      partial: count("partial"),
      inconclusive: count("inconclusive"),
      missed: count("missed")
    }
  };
}
