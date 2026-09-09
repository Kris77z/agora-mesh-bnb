import { createLlmgtwFetch } from "@rebel/shared";
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import {
  DEFAULT_LANGUAGE_CODE,
  buildOutputLanguageInstruction,
  localizeByLocale,
  sameAsset,
  type LanguageCode
} from "@rebel/shared";
import type {
  CommanderPhase,
  CommanderPhaseResult,
  HunterServiceTaskType
} from "@rebel/shared";
import { z } from "zod";
import { hunterConfig } from "./config.js";
import {
  applyCommanderPhaseSpend,
  buildCommanderBudget,
  formatCommanderMoney,
  getCommanderBudgetBlockReason
} from "./commander-budget.js";
import { HunterError } from "./errors.js";
import { runKimiReactLoop } from "./kimi-loop.js";
import type { ReactToolSpec } from "./react-tools.js";
import type { CommanderHunterRunResult, HunterRunResult, SingleHunterRunResult } from "./run-types.js";
import { executePhase, inferTaskTypeFromGoal, runScriptedHunter } from "./scripted-flow.js";
import { emitTrace, type HunterRunOptions } from "./trace-emitter.js";
import { hunterLog, hunterWarn, hunterError } from "./logger.js";

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_PHASE_TIMEOUT_MS = 45000;
type CommanderBudgetSnapshot = ReturnType<typeof buildCommanderBudget>;

const SERVICE_TYPES: HunterServiceTaskType[] = [
  "content-generation",
  "smart-contract-audit",
  "onchain-investigation",
  "defi-analysis",
  "gas-optimization",
  "token-scan",
  "tx-decode",
  "abi-interact",
  "yield-search"
];
const SERVICE_TYPE_SET = new Set<string>(SERVICE_TYPES);

interface CommanderRuntimeState {
  missionId: string;
  goal: string;
  locale: LanguageCode;
  budget: CommanderBudgetSnapshot;
  phaseResults: CommanderPhaseResult[];
  contextParts: string[];
  latestSuccessfulRun: SingleHunterRunResult | null;
  budgetStopReason?: string;
}

interface CommanderFlowDeps {
  llm: {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model: string;
  };
  createMissionId: () => string;
  buildBudget: () => CommanderBudgetSnapshot;
  phaseTimeoutMs: number;
  executePhase: typeof executePhase;
  runScriptedHunter: typeof runScriptedHunter;
  runPlanner: (input: {
    goal: string;
    options: HunterRunOptions;
    llm: CommanderFlowDeps["llm"];
    systemPrompt: string;
    hireAgentSpec: ReactToolSpec;
  }) => Promise<string>;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function buildCommanderPhaseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveMs(env.COMMANDER_PHASE_TIMEOUT_MS, DEFAULT_PHASE_TIMEOUT_MS);
}

const defaultCommanderDeps: CommanderFlowDeps = {
  llm: hunterConfig.llm,
  createMissionId: () => randomUUID(),
  buildBudget: () => buildCommanderBudget(),
  phaseTimeoutMs: buildCommanderPhaseTimeoutMs(),
  executePhase,
  runScriptedHunter,
  runPlanner: async ({ goal, options, llm, systemPrompt, hireAgentSpec }) => {
    if (llm.provider === "kimi") {
      return runKimiReactLoop(
        goal,
        { hire_agent: hireAgentSpec },
        {
          goal,
          missionId: randomUUID(),
          locale: options.locale ?? DEFAULT_LANGUAGE_CODE,
          services: []
        },
        options,
        systemPrompt
      );
    }

    const provider = createOpenAI({
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
      name: llm.provider,
      compatibility: "compatible",
      fetch: createLlmgtwFetch()
    });
    const result = await generateText({
      maxRetries: 0,
      maxTokens: 4096,
      model: provider.chat(llm.model),
      system: systemPrompt,
      prompt: goal,
      tools: {
        hire_agent: tool({
          description: hireAgentSpec.description,
          parameters: z.object({
            goal: z.string().min(1),
            name: z.string().optional(),
            preferredType: z.string().optional()
          }),
          execute: hireAgentSpec.execute
        })
      },
      maxSteps: DEFAULT_MAX_STEPS,
      onStepFinish: (step) => {
        emitTrace(options, "llm_response", {
          stepType: step.stepType,
          toolCalls: step.toolCalls?.length ?? 0,
          hasText: step.text.trim().length > 0
        });
      }
    });
    return result.text;
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildLocalizedInterruptMessage(signal: AbortSignal, locale: LanguageCode): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim().length > 0) {
    return localizeByLocale(locale, {
      en: `Commander interrupted: ${reason}`,
      zh: `指挥模式已中断：${reason}`
    });
  }
  return localizeByLocale(locale, {
    en: "Commander interrupted by user request.",
    zh: "指挥模式已按用户请求中断。"
  });
}

function createInterruptError(signal: AbortSignal, locale: LanguageCode): HunterError {
  return new HunterError(499, "COMMANDER_INTERRUPTED", buildLocalizedInterruptMessage(signal, locale), {
    reason: signal.reason
  });
}

function throwIfInterrupted(options: HunterRunOptions): void {
  if (!options.signal?.aborted) {
    return;
  }
  throw createInterruptError(options.signal, options.locale ?? DEFAULT_LANGUAGE_CODE);
}

function getInterruptReason(options: HunterRunOptions): string | null {
  if (!options.signal?.aborted) {
    return null;
  }
  return buildLocalizedInterruptMessage(options.signal, options.locale ?? DEFAULT_LANGUAGE_CODE);
}

function isInterruptError(error: unknown): error is HunterError {
  return error instanceof HunterError && error.code === "COMMANDER_INTERRUPTED";
}

function createPhaseTimeoutError(phaseName: string, timeoutMs: number, locale: LanguageCode): HunterError {
  return new HunterError(
    504,
    "COMMANDER_PHASE_TIMEOUT",
    localizeByLocale(locale, {
      en: `Phase "${phaseName}" timed out after ${timeoutMs} ms`,
      zh: `阶段“${phaseName}”在 ${timeoutMs} 毫秒后超时`
    }),
    { phaseName, timeoutMs }
  );
}

async function runPhaseWithTimeout(input: {
  run: () => Promise<SingleHunterRunResult>;
  options: HunterRunOptions;
  phaseName: string;
  timeoutMs: number;
}): Promise<SingleHunterRunResult> {
  const { run, options, phaseName, timeoutMs } = input;
  throwIfInterrupted(options);

  const cleanups: Array<() => void> = [];
  let timeoutHandle: NodeJS.Timeout | undefined;
  const phasePromise = run();
  const timeoutPromise = new Promise<SingleHunterRunResult>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(createPhaseTimeoutError(phaseName, timeoutMs, options.locale ?? DEFAULT_LANGUAGE_CODE)),
      timeoutMs
    );
  });

  const race: Array<Promise<SingleHunterRunResult>> = [phasePromise, timeoutPromise];
  if (options.signal) {
    const interruptPromise = new Promise<SingleHunterRunResult>((_, reject) => {
      const onAbort = () =>
        reject(createInterruptError(options.signal!, options.locale ?? DEFAULT_LANGUAGE_CODE));
      options.signal!.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
    });
    race.push(interruptPromise);
  }

  try {
    return await Promise.race(race);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

function normalizeTaskType(raw: unknown): HunterServiceTaskType | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return SERVICE_TYPE_SET.has(raw) ? (raw as HunterServiceTaskType) : undefined;
}

function buildPhaseGoal(goal: string, previousContext: string, locale: LanguageCode): string {
  if (previousContext.trim().length === 0) {
    return goal;
  }
  return `${goal}\n\n${localizeByLocale(locale, {
    en: "Context from previous phases:",
    zh: "前序阶段上下文："
  })}\n${previousContext}`;
}

function summarizeForContext(phase: CommanderPhase, content: string, locale: LanguageCode): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const clipped = compact.length > 1000 ? `${compact.slice(0, 1000)}...` : compact;
  return localizeByLocale(locale, {
    en: `[${phase.name}] ${clipped}`,
    zh: `【${phase.name}】${clipped}`
  });
}

function summarizeToolContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

function readPhaseSpend(
  result: SingleHunterRunResult,
  budget: CommanderBudgetSnapshot
): CommanderBudgetSnapshot["spent"] {
  const purchases = [
    { quote: result.quote, service: result.service },
    ...(result.verification
      ? [{ quote: result.verification.quote, service: result.verification.service }]
      : [])
  ];
  let total = 0n;
  let asset = budget.maxTotal.asset;
  for (const purchase of purchases) {
    const accept = purchase.quote.accepts.find(
      (item) => item.scheme === "native-transfer" || item.scheme === "exact"
    );
    if (!accept || !/^\d+$/.test(accept.amount)) {
      continue;
    }
    const purchaseAsset = purchase.service.asset ?? budget.maxTotal.asset;
    if (!sameAsset(purchaseAsset, asset)) {
      throw new HunterError(
        422,
        "COMMANDER_BUDGET_ASSET_MISMATCH",
        "A phase cannot aggregate Auditor and Verifier payments in different assets"
      );
    }
    asset = purchaseAsset;
    total += BigInt(accept.amount);
  }
  return { asset, amount: total.toString() };
}

function readAvailablePhaseBudget(
  budget: CommanderBudgetSnapshot
): CommanderBudgetSnapshot["maxPerPhase"] {
  const remainingTotal = BigInt(budget.maxTotal.amount) - BigInt(budget.spent.amount);
  const perPhase = BigInt(budget.maxPerPhase.amount);
  return {
    asset: budget.maxPerPhase.asset,
    amount: (remainingTotal < perPhase ? remainingTotal : perPhase).toString()
  };
}

function readRunTaskType(result: SingleHunterRunResult): HunterServiceTaskType | undefined {
  if ("paymentContext" in result.quote) {
    return normalizeTaskType(result.quote.paymentContext.taskType);
  }
  return normalizeTaskType(result.service.taskType);
}

function getBudgetBlockReason(state: CommanderRuntimeState): string | null {
  return getCommanderBudgetBlockReason({
    budget: state.budget,
    stopReason: state.budgetStopReason,
    locale: state.locale
  });
}

function updateBudgetAfterPhase(
  state: CommanderRuntimeState,
  phaseSpent: CommanderBudgetSnapshot["spent"],
  locale: LanguageCode
): void {
  const updated = applyCommanderPhaseSpend({
    budget: state.budget,
    phaseSpent,
    stopReason: state.budgetStopReason,
    locale
  });
  state.budget = updated.budget;
  state.budgetStopReason = updated.stopReason;
}

function buildCommanderSystemPrompt(
  budget: ReturnType<typeof buildCommanderBudget>,
  phaseTimeoutMs: number,
  locale: LanguageCode
): string {
  return `
You are an autonomous mission commander for Agora Mesh.
You can complete work only by calling the hire_agent tool.

Operating rules:
1) Think step-by-step and decide whether another sub-task is needed.
2) Call hire_agent with a concrete sub-goal each time.
3) Stop once the mission has enough evidence/results. Do not call unnecessary tools.
4) If tool output has blocked=true, stop immediately and produce final summary.
5) Max phases: ${budget.maxPhases}. Total budget cap: ${formatCommanderMoney(budget.maxTotal)}. Per-phase cap: ${formatCommanderMoney(
    budget.maxPerPhase
  )}.
6) Preferred task types (optional): ${SERVICE_TYPES.join(", ")}.
7) A single phase may timeout after ${phaseTimeoutMs} ms; timeout means the phase failed and you may retry with a narrower goal.
8) All sub-goals passed to hire_agent must be written in the user's requested language when possible.

Final answer requirements:
- Summarize what was completed.
- Include key findings from successful phases.
- Mention any failed/skipped phases and why.

Output language:
${buildOutputLanguageInstruction({ locale })}
`.trim();
}

function toCommanderResult(
  goal: string,
  finalMessage: string,
  fallback: SingleHunterRunResult,
  phases: CommanderPhaseResult[],
  budget: ReturnType<typeof buildCommanderBudget>,
  locale: LanguageCode
): CommanderHunterRunResult {
  const successCount = phases.filter((item) => item.success).length;
  return {
    ...fallback,
    goal,
    mode: "commander",
    phases,
    budget,
    finalMessage:
      finalMessage.trim().length > 0
        ? finalMessage
        : localizeByLocale(locale, {
            en: `Commander flow completed (${successCount}/${phases.length} phases succeeded, spent ${formatCommanderMoney(
              budget.spent
            )}).`,
            zh: `指挥模式已完成（共成功 ${successCount}/${phases.length} 个阶段，花费 ${formatCommanderMoney(
              budget.spent
            )}）。`
          })
  };
}

export async function runCommanderHunter(
  goal: string,
  options: HunterRunOptions = {},
  depsOverrides: Partial<CommanderFlowDeps> = {}
): Promise<HunterRunResult> {
  const locale = options.locale ?? DEFAULT_LANGUAGE_CODE;
  const deps: CommanderFlowDeps = {
    ...defaultCommanderDeps,
    ...depsOverrides,
    llm: {
      ...defaultCommanderDeps.llm,
      ...(depsOverrides.llm ?? {})
    },
    phaseTimeoutMs: depsOverrides.phaseTimeoutMs ?? defaultCommanderDeps.phaseTimeoutMs
  };

  throwIfInterrupted(options);

  if (deps.llm.provider === "none" || !deps.llm.apiKey) {
    return deps.runScriptedHunter(goal, options);
  }

  const budget = deps.buildBudget();
  const state: CommanderRuntimeState = {
    missionId: options.missionId ?? deps.createMissionId(),
    goal,
    locale,
    budget,
    phaseResults: [],
    contextParts: [],
    latestSuccessfulRun: null
  };

  emitTrace(options, "run_started", {
    missionId: state.missionId,
    mode: "commander",
    goal,
    locale,
    maxPhases: budget.maxPhases,
    maxTotal: budget.maxTotal,
    maxPerPhase: budget.maxPerPhase,
    phaseTimeoutMs: deps.phaseTimeoutMs
  });
  emitTrace(options, "mission_decomposed", {
    phases: [],
    strategy: "react-autonomous",
    budget,
    phaseTimeoutMs: deps.phaseTimeoutMs
  });

  hunterLog(`=== COMMANDER START === mission=${state.missionId}`);
  hunterLog(`goal: "${goal.slice(0, 150)}${goal.length > 150 ? '...' : ''}"`);
  hunterLog(`budget: maxPhases=${budget.maxPhases}, maxTotal=${formatCommanderMoney(budget.maxTotal)}, perPhase=${formatCommanderMoney(budget.maxPerPhase)}, timeout=${deps.phaseTimeoutMs}ms`);

  const hireAgentSchema = z.object({
    goal: z.string().min(1),
    name: z.string().optional(),
    preferredType: z.string().optional()
  });

  const hireAgentSpec: ReactToolSpec = {
    description: "Hire a specialized agent to execute one concrete sub-task",
    schema: hireAgentSchema,
    jsonSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        name: { type: "string" },
        preferredType: { type: "string" }
      },
      required: ["goal"],
      additionalProperties: false
    },
    execute: async (args) => {
      const parsed = hireAgentSchema.parse(args);
      const interruptReason = getInterruptReason(options);
      if (interruptReason) {
        hunterWarn(`commander: interrupted — ${interruptReason}`);
        state.budgetStopReason = state.budgetStopReason ?? interruptReason;
        return {
          ok: false,
          blocked: true,
          reason: interruptReason,
          budget: state.budget
        };
      }
      const blockedReason = getBudgetBlockReason(state);
      if (blockedReason) {
        hunterWarn(`commander: budget blocked — ${blockedReason}`);
        return {
          ok: false,
          blocked: true,
          reason: blockedReason,
          budget: state.budget
        };
      }

      const index = state.phaseResults.length;
      const rawGoal = parsed.goal.trim();
      const phaseName =
        parsed.name && parsed.name.trim().length > 0
          ? parsed.name.trim()
          : localizeByLocale(locale, {
              en: `Phase ${index + 1}`,
              zh: `阶段 ${index + 1}`
            });
      const taskTypeHint = normalizeTaskType(parsed.preferredType);
      const isSecurityPhase =
        taskTypeHint === "smart-contract-audit" ||
        inferTaskTypeFromGoal(rawGoal) === "smart-contract-audit";
      const phaseGoal =
        isSecurityPhase && inferTaskTypeFromGoal(state.goal) === "smart-contract-audit"
          ? state.goal
          : buildPhaseGoal(rawGoal, state.contextParts.join("\n"), locale);

      const placeholderTaskType = taskTypeHint ?? "content-generation";
      emitTrace(options, "phase_started", {
        index,
        name: phaseName,
        taskType: placeholderTaskType,
        goal: rawGoal
      });
      hunterLog(`commander: phase ${index} "${phaseName}" (${placeholderTaskType}) starting...`);

      const phase: CommanderPhase = {
        name: phaseName,
        taskType: placeholderTaskType,
        goal: rawGoal
      };

      const phaseResultBase = {
        index,
        name: phaseName,
        goal: rawGoal
      };

      let runResult: SingleHunterRunResult;
      try {
        runResult = await runPhaseWithTimeout({
          run: () =>
            deps.executePhase(phaseGoal, options, {
              preferredTaskType: taskTypeHint,
              missionId: state.missionId,
              emitLifecycleEvents: false,
              maxSpend: readAvailablePhaseBudget(state.budget)
            }),
          options,
          phaseName,
          timeoutMs: deps.phaseTimeoutMs
        });
      } catch (error) {
        const message = errorMessage(error);
        hunterError(`commander: phase ${index} "${phaseName}" FAILED — ${message}`);
        const failContent = localizeByLocale(locale, {
          en: `[Phase failed] ${message}`,
          zh: `【阶段失败】${message}`
        });
        const failedResult: CommanderPhaseResult = {
          index,
          phase,
          success: false,
          content: failContent,
          error: message
        };
        state.phaseResults.push(failedResult);
        state.contextParts.push(
          localizeByLocale(locale, {
            en: `[${phaseName} failed] ${message}`,
            zh: `【${phaseName}失败】${message}`
          })
        );
        state.budget.phaseCount += 1;
        if (isInterruptError(error)) {
          state.budgetStopReason = state.budgetStopReason ?? message;
        }
        emitTrace(options, "phase_completed", {
          ...phaseResultBase,
          taskType: phase.taskType,
          content: failContent,
          error: message
        });
        return {
          ok: false,
          blocked: isInterruptError(error),
          reason: isInterruptError(error) ? message : undefined,
          phase: failedResult,
          budget: state.budget
        };
      }

      state.latestSuccessfulRun = runResult;
      const resolvedTaskType = readRunTaskType(runResult) ?? taskTypeHint ?? "content-generation";
      phase.taskType = resolvedTaskType;

      const content = runResult.execution.result;
      const phaseSpent = readPhaseSpend(runResult, state.budget);
      updateBudgetAfterPhase(state, phaseSpent, locale);

      const successPhase: CommanderPhaseResult = {
        index,
        phase,
        success: true,
        content
      };
      state.phaseResults.push(successPhase);
      state.contextParts.push(summarizeForContext(phase, content, locale));

      emitTrace(options, "phase_completed", {
        ...phaseResultBase,
        taskType: phase.taskType,
        content
      });
      hunterLog(`commander: phase ${index} "${phaseName}" DONE — spent=${formatCommanderMoney(phaseSpent)}, total=${formatCommanderMoney(state.budget.spent)}`);

      return {
        ok: true,
        blocked: Boolean(state.budgetStopReason),
        reason: state.budgetStopReason,
        phase: {
          index,
          name: phaseName,
          taskType: phase.taskType,
          spent: phaseSpent,
          summary: summarizeToolContent(content),
          success: true
        },
        budget: state.budget
      };
    }
  };

  hunterLog(`commander: planner starting (llm=${deps.llm.provider}:${deps.llm.model})...`);
  const finalMessage = await deps.runPlanner({
    goal,
    options,
    llm: deps.llm,
    systemPrompt: buildCommanderSystemPrompt(state.budget, deps.phaseTimeoutMs, locale),
    hireAgentSpec
  });
  hunterLog(`commander: planner finished — ${state.phaseResults.length} phases executed`);

  const interruptReason = getInterruptReason(options);
  if (interruptReason) {
    state.budgetStopReason = state.budgetStopReason ?? interruptReason;
  }

  if (state.phaseResults.length === 0 && !interruptReason) {
    const fallbackPhaseName = localizeByLocale(locale, {
      en: "Fallback Phase",
      zh: "回退阶段"
    });
    hunterWarn(`commander: planner did not call hire_agent — running fallback phase`);
    emitTrace(options, "phase_started", {
      index: 0,
      name: fallbackPhaseName,
      taskType: "content-generation",
      goal
    });
    const runResult = await runPhaseWithTimeout({
      run: () =>
        deps.executePhase(goal, options, {
          missionId: state.missionId,
          emitLifecycleEvents: false,
          maxSpend: readAvailablePhaseBudget(state.budget)
        }),
      options,
      phaseName: fallbackPhaseName,
      timeoutMs: deps.phaseTimeoutMs
    });
    state.latestSuccessfulRun = runResult;
    const resolvedTaskType = readRunTaskType(runResult) ?? "content-generation";
    const fallbackPhase: CommanderPhaseResult = {
      index: 0,
      phase: {
        name: fallbackPhaseName,
        taskType: resolvedTaskType,
        goal
      },
      success: true,
      content: runResult.execution.result
    };
    state.phaseResults.push(fallbackPhase);
    const phaseSpent = readPhaseSpend(runResult, state.budget);
    updateBudgetAfterPhase(state, phaseSpent, locale);
    emitTrace(options, "phase_completed", {
      index: 0,
      name: fallbackPhase.phase.name,
      taskType: fallbackPhase.phase.taskType,
      content: fallbackPhase.content
    });
  }

  if (!state.latestSuccessfulRun) {
    if (interruptReason) {
      hunterError(`commander: ALL PHASES FAILED (interrupted) — ${interruptReason}`);
      throw new HunterError(499, "COMMANDER_INTERRUPTED", interruptReason, {
        phases: state.phaseResults
      });
    }
    hunterError(`commander: ALL PHASES FAILED — no successful result`);
    throw new HunterError(
      502,
      "COMMANDER_ALL_PHASES_FAILED",
      localizeByLocale(locale, {
        en: "All commander phases failed",
        zh: "指挥模式的所有阶段都失败了"
      }),
      {
        phases: state.phaseResults
      }
    );
  }

  const resolvedFinalMessage =
    interruptReason && finalMessage.trim().length > 0
      ? `${finalMessage}\n\n${localizeByLocale(locale, {
          en: "Execution interrupted before all planned phases completed.",
          zh: "在所有计划阶段完成之前，执行已中断。"
        })}`
      : interruptReason
        ? localizeByLocale(locale, {
            en: "Commander interrupted before all planned phases completed.",
            zh: "在所有计划阶段完成之前，指挥模式已中断。"
          })
        : finalMessage;

  const result = toCommanderResult(
    goal,
    resolvedFinalMessage,
    state.latestSuccessfulRun,
    state.phaseResults,
    state.budget,
    locale
  );
  emitTrace(options, "run_completed", {
    mode: result.mode,
    phaseCount: state.phaseResults.length,
    succeededPhases: state.phaseResults.filter((item) => item.success).length,
    receiptVerified: result.receiptVerified,
    score: result.evaluation.score,
    spent: state.budget.spent
  });
  const successCount = state.phaseResults.filter((item) => item.success).length;
  hunterLog(`=== COMMANDER DONE === ${successCount}/${state.phaseResults.length} phases succeeded, spent=${formatCommanderMoney(state.budget.spent)}`);
  return result;
}
