import { createLlmgtwFetch } from "@rebel/shared";
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import {
  DEFAULT_LANGUAGE_CODE,
  localizeByLocale,
} from "@rebel/shared";
import type {
  HunterRunRequestMode,
  HunterTraceEvent,
  HunterTraceEventType,
  ServiceInfo
} from "@rebel/shared";
import { submitAutoFeedback } from "./feedback-autopilot.js";
import { runCommanderHunter } from "./commander-flow.js";
import { hunterConfig } from "./config.js";
import { localizeHunterError } from "./error-messages.js";
import { HunterError } from "./errors.js";
import { runKimiReactLoop } from "./kimi-loop.js";
import { buildMemoryPrompt } from "./memory.js";
import { buildHunterSystemPrompt } from "./prompts.js";
import {
  createReactTools,
  executeReactToolWithTrace,
  type HunterRuntimeState
} from "./react-tools.js";
import { inferTaskTypeFromGoal, runScriptedHunter } from "./scripted-flow.js";
import type { HunterRunResult, SingleHunterRunResult } from "./run-types.js";
import { emitTrace, type HunterRunOptions } from "./trace-emitter.js";
import { reflectAndStoreExperience } from "./tools/reflect.js";
import { discoverServices } from "./tools/discover.js";
import { evaluateResultTool, verifyReceiptTool } from "./tools/verify.js";

export type { HunterRunOptions } from "./trace-emitter.js";
export type { HunterTraceEvent, HunterTraceEventType } from "@rebel/shared";
export { runScriptedHunter } from "./scripted-flow.js";
export type { HunterRunResult } from "./run-types.js";

function buildReputationPromptContext(services: ServiceInfo[]): string {
  const withReputation = services
    .filter((item) => item.reputation)
    .sort((a, b) => (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0));
  if (withReputation.length === 0) {
    return "No reputation records yet. Use price + memory and keep exploration.";
  }
  return withReputation
    .slice(0, 6)
    .map((item, index) => {
      const rep = item.reputation!;
      const qualifiedText = rep.qualified ? "qualified" : "insufficient-samples";
      return `${index + 1}. ${item.id}: score=${rep.score}/5 count=${rep.count} trend=${rep.trend} (${qualifiedText}) price=${item.price}`;
    })
    .join("\n");
}

export async function runReactHunter(
  goal: string,
  options: HunterRunOptions = {}
): Promise<SingleHunterRunResult> {
  const locale = options.locale ?? DEFAULT_LANGUAGE_CODE;
  const missionId = options.missionId ?? randomUUID();
  emitTrace(options, "run_started", { missionId, mode: "react", goal, locale });

  if (hunterConfig.llm.provider === "none" || !hunterConfig.llm.apiKey) {
    throw new HunterError(
      500,
      "LLM_KEY_MISSING",
      localizeByLocale(locale, {
        en: "KIMI_API_KEY or OPENAI_API_KEY is required for HUNTER_USE_REACT=true mode",
        zh: "启用 HUNTER_USE_REACT=true 时必须配置 KIMI_API_KEY 或 OPENAI_API_KEY"
      })
    );
  }

  const inferredTaskType = inferTaskTypeFromGoal(goal);
  const [memoryContext, reputationContext] = await Promise.all([
    buildMemoryPrompt({
      goal,
      taskType: inferredTaskType
    }),
    (async () => {
      try {
        const services = await discoverServices();
        return buildReputationPromptContext(services);
      } catch {
        return "Failed to load reputation context.";
      }
    })()
  ]);
  const systemPrompt = buildHunterSystemPrompt(memoryContext, reputationContext, locale);
  const state: HunterRuntimeState = {
    goal,
    missionId,
    locale,
    services: []
  };

  const toolSpecs = createReactTools(state);
  const tools = Object.fromEntries(
    Object.entries(toolSpecs).map(([name, spec]) => [
      name,
      tool({
        description: spec.description,
        parameters: spec.schema,
        execute: async (args) =>
          executeReactToolWithTrace({
            toolName: name,
            args,
            tools: toolSpecs,
            state,
            options
          })
      })
    ])
  );

  const text =
    hunterConfig.llm.provider === "kimi"
      ? await runKimiReactLoop(goal, toolSpecs, state, options, systemPrompt)
      : await (async () => {
          const provider = createOpenAI({
            apiKey: hunterConfig.llm.apiKey,
            baseURL: hunterConfig.llm.baseURL,
            name: hunterConfig.llm.provider,
            compatibility: "compatible",
            fetch: createLlmgtwFetch()
          });
          const result = await generateText({
            maxRetries: 0,
            maxTokens: 4096,
            model: provider.chat(hunterConfig.llm.model),
            system: systemPrompt,
            prompt: goal,
            tools,
            maxSteps: 12,
            onStepFinish: (step) => {
              emitTrace(options, "llm_response", {
                stepType: step.stepType,
                toolCalls: step.toolCalls?.length ?? 0,
                hasText: step.text.trim().length > 0
              });
            }
          });
          return result.text;
        })();

  if (!state.service || !state.quote || !state.paymentTx || !state.execution) {
    throw new HunterError(
      500,
      "REACT_INCOMPLETE",
      localizeByLocale(locale, {
        en: "ReAct flow ended without completing payment flow",
        zh: "ReAct 流程在完成支付链路前结束"
      })
    );
  }

  const receiptCheck = verifyReceiptTool(state.execution.receipt, {
    result: state.execution.result,
    provider: state.service.provider
  });
  const evaluation = state.evaluation ?? evaluateResultTool(state.execution.result);
  if (state.receiptVerified === undefined) {
    emitTrace(options, "receipt_verified", {
      isValid: receiptCheck.isValid,
      signatureValid: receiptCheck.signatureValid,
      resultHashMatches: receiptCheck.resultHashMatches,
      providerMatches: receiptCheck.providerMatches,
      provider: state.execution.receipt.provider,
      requestHash: state.execution.receipt.requestHash
    });
  }
  if (!state.evaluation) {
    emitTrace(options, "evaluation_completed", evaluation);
  }
  if (!state.feedback) {
    try {
      const feedback = await submitAutoFeedback({
        service: state.service,
        evaluation,
        missionId: state.missionId,
        taskType: state.quote.paymentContext.taskType
      });
      emitTrace(options, "feedback_submitted", feedback);
    } catch {
      // Best-effort feedback should not fail the core payment run.
    }
  }
  if (!state.reflection) {
    state.reflection = await reflectAndStoreExperience({
      missionId: state.missionId,
      goal,
      serviceUsed: state.service.id,
      taskType: state.quote.paymentContext.taskType,
      score: evaluation.score,
      result: state.execution.result,
      locale,
      evaluationSummary: evaluation.summary
    });
    emitTrace(options, "tool_result", {
      tool: "reflect",
      result: {
        missionId: state.reflection.missionId,
        taskType: state.reflection.taskType,
        score: state.reflection.score,
        lesson: state.reflection.lesson
      }
    });
  }

  const runResult: HunterRunResult = {
    missionId: state.missionId,
    goal,
    mode: "react",
    service: state.service,
    quote: state.quote,
    paymentTx: state.paymentTx,
    execution: state.execution,
    receiptVerified: receiptCheck.isValid,
    evaluation,
    reflection: state.reflection,
    finalMessage: text
  };
  emitTrace(options, "run_completed", {
    mode: runResult.mode,
    receiptVerified: runResult.receiptVerified,
    score: runResult.evaluation.score
  });
  return runResult;
}

export async function runHunter(
  goal: string,
  options: HunterRunOptions = {},
  requestMode: HunterRunRequestMode = "single"
): Promise<HunterRunResult> {
  try {
    if (requestMode === "commander") {
      return await runCommanderHunter(goal, options);
    }
    if (hunterConfig.useReact && inferTaskTypeFromGoal(goal) !== "smart-contract-audit") {
      return await runReactHunter(goal, options);
    }
    return await runScriptedHunter(goal, options);
  } catch (error) {
    const localizedError =
      error instanceof HunterError
        ? localizeHunterError(error, options.locale ?? DEFAULT_LANGUAGE_CODE)
        : localizeHunterError(
            new HunterError(500, "INTERNAL_ERROR", "Hunter execution failed; inspect server logs"),
            options.locale ?? DEFAULT_LANGUAGE_CODE
          );
    emitTrace(options, "run_failed", {
      message: localizedError.message,
      locale: options.locale ?? DEFAULT_LANGUAGE_CODE
    });
    throw localizedError;
  }
}
