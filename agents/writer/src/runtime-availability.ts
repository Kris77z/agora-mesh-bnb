import { writerConfig } from "./config.js";
import type { LoadedSkill } from "./skill-loader.js";

export interface SkillRuntimeAvailability {
  available: boolean;
  reason?: string;
}

export function getSkillRuntimeAvailability(skill: LoadedSkill): SkillRuntimeAvailability {
  if (skill.config.output.schemaName === "audit-vulnerabilities-v1" &&
      (writerConfig.llm.provider === "none" || !writerConfig.llm.apiKey)) {
    return { available: false, reason: "No LLM API key configured for audit output" };
  }
  return { available: true };
}
