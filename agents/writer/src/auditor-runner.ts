import { createLlmgtwFetch } from "@rebel/shared";
import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  buildOutputLanguageInstruction,
  type LanguageCode,
  type SecurityTaskInput
} from "@rebel/shared";
import { writerConfig } from "./config.js";
import { WriterError } from "./errors.js";
import { resolveSkillForTaskType } from "./skill-loader.js";
import { validateStructuredSkillOutput } from "./structured-output.js";
import { withHardTimeout } from "./hard-timeout.js";

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutStart = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "");
  return withoutStart.replace(/\n?```$/, "").trim();
}

export interface ScopedAuditTask {
  taskInput: string;
  scope: {
    kind: "verified-first-party-source-units";
    packageSourceHash: string;
    scopeSourceHash: string;
    includedSourceUnits: string[];
    omittedDependencySourceUnits: string[];
    sourceBytes: number;
    limitation: string;
  };
}

function combineSourceUnits(sources: Record<string, string>): string {
  return Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceUnit, source]) => `// ===== Source unit: ${sourceUnit} =====\n${source.trimEnd()}`)
    .join("\n\n");
}

export function buildFirstPartyAuditTask(input: SecurityTaskInput): ScopedAuditTask {
  if (input.mode !== "verified-source" || !input.sources) {
    throw new WriterError(
      400,
      "INVALID_PAYLOAD",
      "Scoped audit requires explorer-verified multi-file source"
    );
  }
  const entries = Object.entries(input.sources);
  const firstPartyEntries = entries.filter(([sourceUnit]) => sourceUnit.startsWith("src/"));
  if (firstPartyEntries.length === 0) {
    throw new WriterError(
      400,
      "INVALID_PAYLOAD",
      "Scoped audit could not identify first-party src/ source units"
    );
  }
  const sources = Object.fromEntries(firstPartyEntries);
  const source = combineSourceUnits(sources);
  const scopeSourceHash = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const includedSourceUnits = Object.keys(sources).sort();
  const omittedDependencySourceUnits = entries
    .map(([sourceUnit]) => sourceUnit)
    .filter((sourceUnit) => !includedSourceUnits.includes(sourceUnit))
    .sort();
  const limitation =
    "The LLM review is scoped to explorer-verified first-party src/ units. Omitted dependency units remain in the package and must be covered by compiler-backed analysis and dependency provenance review.";
  const auditScope = {
    kind: "verified-first-party-source-units" as const,
    packageSourceHash: input.sourceHash,
    scopeSourceHash,
    includedSourceUnits,
    omittedDependencySourceUnits,
    sourceBytes: Buffer.byteLength(source),
    limitation
  };
  return {
    scope: auditScope,
    taskInput: JSON.stringify({
      version: 1,
      chainId: input.chainId,
      mode: input.mode,
      sourceName: input.sourceName,
      source,
      sourceHash: scopeSourceHash,
      packageSourceHash: input.sourceHash,
      sources,
      contractAddress: input.contractAddress,
      explorerUrl: input.explorerUrl,
      auditScope
    })
  };
}

export function normalizeAuditorOutput(output: string): string {
  const candidate = stripMarkdownFence(output);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new WriterError(502, "INVALID_SKILL_OUTPUT", "Auditor must return valid JSON");
  }
  try {
    return JSON.stringify(
      validateStructuredSkillOutput("audit-vulnerabilities-v1", parsed),
      null,
      2
    );
  } catch (error) {
    throw new WriterError(
      502,
      "INVALID_SKILL_OUTPUT",
      "Auditor returned JSON that does not match audit-vulnerabilities-v1",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function runProductionAudit(
  taskInput: string,
  locale: LanguageCode = "en-US"
): Promise<string> {
  if (!taskInput.trim()) {
    throw new WriterError(400, "INVALID_PAYLOAD", "taskInput is required");
  }
  if (writerConfig.llm.provider === "none" || !writerConfig.llm.apiKey) {
    throw new WriterError(
      503,
      "AUDITOR_MODEL_UNAVAILABLE",
      "Auditor is unavailable because no LLM API key is configured"
    );
  }
  const skill = resolveSkillForTaskType("smart-contract-audit");
  const provider = createOpenAI({
    apiKey: writerConfig.llm.apiKey,
    baseURL: writerConfig.llm.baseURL,
    name: writerConfig.llm.provider,
    compatibility: "compatible",
    fetch: createLlmgtwFetch()
  });
  try {
    const { text } = await withHardTimeout(
      writerConfig.llm.timeoutMs,
      (abortSignal) => generateText({
        maxRetries: 0,
        maxTokens: 4096,
        model: provider.chat(writerConfig.llm.model),
        system: [
          skill.prompt,
          "",
          "Output language rules:",
          buildOutputLanguageInstruction({ locale, outputType: "json" })
        ].join("\n"),
        prompt: [
          "Task type: smart-contract-audit",
          `Requested locale: ${locale}`,
          `Task input: ${taskInput.trim()}`
        ].join("\n"),
        abortSignal,
        temperature: writerConfig.llm.provider === "kimi"
          ? 1
          : skill.config.llm?.temperature
      }),
      "auditor model request"
    );
    return normalizeAuditorOutput(text);
  } catch (error) {
    if (error instanceof WriterError) throw error;
    throw new WriterError(
      502,
      "AUDITOR_EXECUTION_FAILED",
      error instanceof Error ? error.message : "Auditor model execution failed"
    );
  }
}
