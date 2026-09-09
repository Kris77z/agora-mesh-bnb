import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { writerConfig } from "./config.js";

export interface OrdinaryBaselineModelResult {
  provider: string;
  model: string;
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export async function runOrdinaryBaselineModel(input: {
  system: string;
  prompt: string;
  model?: string;
}): Promise<OrdinaryBaselineModelResult> {
  if (writerConfig.llm.provider === "none" || !writerConfig.llm.apiKey) {
    throw new Error("No ordinary LLM API key is configured for the baseline candidate");
  }
  const model = input.model?.trim() || writerConfig.llm.model;
  const provider = createOpenAI({
    apiKey: writerConfig.llm.apiKey,
    baseURL: writerConfig.llm.baseURL,
    name: `${writerConfig.llm.provider}-ordinary-baseline`,
    compatibility: "compatible"
  });
  const response = await generateText({
    maxRetries: 0,
    maxTokens: 4096,
    model: provider.chat(model),
    system: input.system,
    prompt: input.prompt,
    abortSignal: AbortSignal.timeout(300_000),
    temperature: writerConfig.llm.provider === "kimi" ? 1 : 0.2
  });
  return {
    provider: writerConfig.llm.provider,
    model,
    text: response.text,
    usage: response.usage
  };
}
