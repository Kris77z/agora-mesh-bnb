import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  DEFAULT_LANGUAGE_CODE,
  buildOutputLanguageInstruction,
  localizeByLocale,
  type LanguageCode
} from "@rebel/shared";
import { WriterError } from "./errors.js";
import { getWriterAgentId } from "./identity.js";
import { writerConfig } from "./config.js";
import { resolveSkillForTaskType, type LoadedSkill } from "./skill-loader.js";
import { validateStructuredSkillOutput } from "./structured-output.js";
import { runProductionOnchainInvestigation } from "./investigation/onchain-investigator.js";
import { runProductionTokenRiskVerification } from "./investigation/token-risk-verifier.js";
import { runDeterministicVerification } from "./verification/deterministic-verifier.js";
import { getSkillRuntimeAvailability } from "./runtime-availability.js";
import { withHardTimeout } from "./hard-timeout.js";

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutStart = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "");
  return withoutStart.replace(/\n?```$/, "").trim();
}

function normalizeSkillOutput(skill: LoadedSkill, output: string): string {
  const normalized = output.trim();
  if (skill.config.output.type !== "json") {
    return normalized;
  }

  const candidate = stripMarkdownFence(normalized);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new WriterError(502, "INVALID_SKILL_OUTPUT", `Skill ${skill.config.id} must return valid JSON`);
  }
  try {
    return JSON.stringify(validateStructuredSkillOutput(skill.config.output.schemaName, parsed), null, 2);
  } catch (error) {
    throw new WriterError(
      502,
      "INVALID_SKILL_OUTPUT",
      `Skill ${skill.config.id} returned JSON that does not match ${skill.config.output.schemaName ?? "its schema"}`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function buildFallbackResult(
  input: { taskType: string; taskInput: string; locale: LanguageCode },
  skill: LoadedSkill,
  reason: string
): string {
  const fallbackSummary =
    skill.config.fallback?.summary && input.locale === "en-US"
      ? skill.config.fallback.summary
      : localizeByLocale(input.locale, {
          en: "Monad is a high-performance EVM-compatible L1 focused on low-latency execution and high throughput.",
          zh: "Monad 是一个高性能、兼容 EVM 的 L1，重点在于低延迟执行和高吞吐。"
        });

  if (skill.config.output.type === "json") {
    return JSON.stringify(
      {
        vulnerabilities: [],
        fallback: {
          taskType: skill.canonicalTaskType,
          serviceId: skill.config.id,
          reason: localizeByLocale(input.locale, {
            en: reason,
            zh: `回退执行：${reason}`
          })
        }
      },
      null,
      2
    );
  }

  return [
    localizeByLocale(input.locale, {
      en: `Service: ${skill.config.id}`,
      zh: `服务: ${skill.config.id}`
    }),
    localizeByLocale(input.locale, {
      en: `TaskType: ${skill.canonicalTaskType}`,
      zh: `任务类型: ${skill.canonicalTaskType}`
    }),
    localizeByLocale(input.locale, {
      en: `Fallback reason: ${reason}`,
      zh: `回退原因: ${reason}`
    }),
    localizeByLocale(input.locale, {
      en: `Task: ${input.taskInput.trim()}`,
      zh: `任务: ${input.taskInput.trim()}`
    }),
    "",
    fallbackSummary
  ].join("\n");
}

function buildWriterSystemPrompt(skill: LoadedSkill, locale: LanguageCode): string {
  return [
    skill.prompt,
    "",
    "Output language rules:",
    buildOutputLanguageInstruction({
      locale,
      outputType: skill.config.output.type
    })
  ].join("\n");
}

export function assertSkillRuntimeAvailable(skill: LoadedSkill): void {
  const availability = getSkillRuntimeAvailability(skill);
  if (!availability.available) {
    throw new WriterError(
      503,
      "AUDITOR_MODEL_UNAVAILABLE",
      availability.reason ?? "Skill runtime is unavailable"
    );
  }
}

export async function executeTask(input: {
  taskType: string;
  taskInput: string;
  locale?: LanguageCode;
}): Promise<string> {
  const locale = input.locale ?? DEFAULT_LANGUAGE_CODE;
  const normalizedTask = input.taskInput.trim();
  if (!normalizedTask) {
    throw new WriterError(400, "INVALID_PAYLOAD", "taskInput is required");
  }
  const skill = resolveSkillForTaskType(input.taskType);
  const normalizedTaskType = skill.canonicalTaskType;
  assertSkillRuntimeAvailable(skill);

  if (skill.config.id === "verifier-v1") {
    try {
      return JSON.stringify(
        runDeterministicVerification(
          normalizedTask,
          getWriterAgentId()
        ),
        null,
        2
      );
    } catch (error) {
      throw new WriterError(
        400,
        "INVALID_VERIFICATION_INPUT",
        error instanceof Error ? error.message : "Verifier input must be valid source + findings JSON"
      );
    }
  }

  if (skill.config.id === "investigator-v1") {
    try {
      const report = await runProductionOnchainInvestigation(normalizedTask);
      return JSON.stringify(
        validateStructuredSkillOutput(skill.config.output.schemaName, report),
        null,
        2
      );
    } catch (error) {
      if (error instanceof WriterError) throw error;
      throw new WriterError(
        502,
        "INVESTIGATION_RPC_FAILED",
        error instanceof Error ? error.message : "Onchain RPC investigation failed"
      );
    }
  }

  if (skill.config.id === "risk-verifier-v1") {
    try {
      const report = await runProductionTokenRiskVerification(normalizedTask);
      return JSON.stringify(
        validateStructuredSkillOutput(skill.config.output.schemaName, report),
        null,
        2
      );
    } catch (error) {
      if (error instanceof WriterError) throw error;
      throw new WriterError(
        502,
        "TOKEN_RISK_VERIFICATION_FAILED",
        error instanceof Error ? error.message : "Historical token-risk replay failed"
      );
    }
  }

  if (writerConfig.llm.provider === "none" || !writerConfig.llm.apiKey) {
    return buildFallbackResult(
      {
        taskType: normalizedTaskType,
        taskInput: normalizedTask,
        locale
      },
      skill,
      "No LLM API key configured (KIMI_API_KEY / OPENAI_API_KEY)"
    );
  }

  try {
    const provider = createOpenAI({
      apiKey: writerConfig.llm.apiKey,
      baseURL: writerConfig.llm.baseURL,
      name: writerConfig.llm.provider,
      compatibility: "compatible"
    });

    const { text } = await withHardTimeout(
      writerConfig.llm.timeoutMs,
      (abortSignal) => generateText({
        model: provider.chat(writerConfig.llm.model),
        system: buildWriterSystemPrompt(skill, locale),
        prompt: [
          `Task type: ${normalizedTaskType}`,
          `Requested locale: ${locale}`,
          `Task input: ${normalizedTask}`
        ].join("\n"),
        abortSignal,
        // Kimi models only accept temperature=1; override any skill-level config
        temperature:
          writerConfig.llm.provider === "kimi" ? 1 : (skill.config.llm?.temperature ?? undefined)
      }),
      `${skill.config.id} model request`
    );
    return normalizeSkillOutput(skill, text);
  } catch (error) {
    if (skill.config.output.schemaName === "audit-vulnerabilities-v1") {
      throw new WriterError(
        502,
        "AUDITOR_EXECUTION_FAILED",
        error instanceof Error ? error.message : "Auditor model execution failed"
      );
    }
    // Keep local MVP flow unblocked when model call fails (e.g., invalid key / rate limits).
    return buildFallbackResult(
      {
        taskType: normalizedTaskType,
        taskInput: normalizedTask,
        locale
      },
      skill,
      error instanceof Error ? error.message : String(error)
    );
  }
}
