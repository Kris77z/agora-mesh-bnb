import { createLlmgtwFetch } from "@rebel/shared";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { buildOutputLanguageInstruction, type LanguageCode } from "@rebel/shared";
import { hunterConfig } from "../config.js";
import { appendExperience, toLessonTranslations, type Experience } from "../memory.js";

interface ReflectInput {
  missionId: string;
  goal: string;
  serviceUsed: string;
  taskType: string;
  score: number;
  result: string;
  locale: LanguageCode;
  evaluationSummary?: string;
  lessonHint?: string;
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function fallbackLesson(input: ReflectInput): string {
  const summary = input.evaluationSummary?.trim();
  if (summary && summary.length > 0) {
    return summary.slice(0, 180);
  }
  if (input.locale === "zh-CN") {
    if (input.score >= 80) {
      return `${input.taskType} 策略有效；保留当前服务选择和校验流程。`;
    }
    if (input.score >= 60) {
      return "结果基本可用；下次在付款完成前收紧提示词约束和结果校验。";
    }
    return `${input.taskType} 结果质量偏低；下次任务需要更严格的服务选择和输出检查。`;
  }

  if (input.score >= 80) {
    return `Strategy worked for ${input.taskType}; keep similar service selection and validation flow.`;
  }
  if (input.score >= 60) {
    return `Result was acceptable; refine prompt constraints and validation before payment completion.`;
  }
  return `Low quality outcome on ${input.taskType}; tighten service choice and output checks next mission.`;
}

async function summarizeLesson(input: ReflectInput): Promise<string> {
  if (input.lessonHint && input.lessonHint.trim().length > 0) {
    return input.lessonHint.trim().slice(0, 200);
  }

  if (hunterConfig.llm.provider === "none" || !hunterConfig.llm.apiKey) {
    return fallbackLesson(input);
  }

  try {
    const provider = createOpenAI({
      apiKey: hunterConfig.llm.apiKey,
      baseURL: hunterConfig.llm.baseURL,
      name: hunterConfig.llm.provider,
      compatibility: "compatible",
      fetch: createLlmgtwFetch()
    });
    const { text } = await generateText({
      maxRetries: 0,
      maxTokens: 4096,
      model: provider.chat(hunterConfig.llm.model),
      system: [
        "You summarize one concrete lesson from mission outcomes.",
        "Keep it under 30 words, actionable, and specific.",
        buildOutputLanguageInstruction({ locale: input.locale, outputType: "text" })
      ].join(" "),
      prompt: [
        `goal: ${input.goal}`,
        `service: ${input.serviceUsed}`,
        `taskType: ${input.taskType}`,
        `score: ${input.score}`,
        `evaluation: ${input.evaluationSummary ?? "n/a"}`,
        `result: ${input.result.slice(0, 1200)}`
      ].join("\n"),
      temperature: hunterConfig.llm.provider === "kimi" ? 1 : 0.3
    });
    const lesson = text.trim().replace(/\s+/g, " ");
    return lesson.length > 0 ? lesson.slice(0, 200) : fallbackLesson(input);
  } catch {
    return fallbackLesson(input);
  }
}

export async function reflectAndStoreExperience(input: ReflectInput): Promise<Experience> {
  const lesson = await summarizeLesson(input);
  const experience: Experience = {
    missionId: input.missionId,
    goal: input.goal,
    serviceUsed: input.serviceUsed,
    taskType: input.taskType,
    score: clampScore(input.score),
    lesson,
    lessonTranslations: toLessonTranslations(input.locale, lesson),
    timestamp: Math.floor(Date.now() / 1000)
  };
  await appendExperience(experience);
  return experience;
}
