import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WriterError } from "./errors.js";
import { writerConfig } from "./config.js";

const skillConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabledByDefault: z.boolean().default(true),
  description: z.string().optional(),
  taskTypes: z.array(z.string().min(1)).min(1),
  skills: z.array(z.string().min(1)).default([]),
  priceWei: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  output: z.object({
    type: z.enum(["text", "json"]),
    schemaName: z.string().optional()
  }),
  llm: z
    .object({
      temperature: z.number().min(0).max(2).optional()
    })
    .optional(),
  fallback: z
    .object({
      summary: z.string().optional()
    })
    .optional()
});

export interface SkillConfig extends z.infer<typeof skillConfigSchema> {}

export interface LoadedSkill {
  skillName: string;
  canonicalTaskType: string;
  prompt: string;
  config: SkillConfig;
}

interface SkillCatalog {
  skills: LoadedSkill[];
  byKey: Map<string, LoadedSkill>;
}

let cachedCatalog: SkillCatalog | undefined;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveServicesRoot(): string {
  const base = process.env.INIT_CWD ?? process.cwd();
  const candidates = [
    path.resolve(base, "agents/services"),
    path.resolve(process.cwd(), "../services")
  ];
  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new WriterError(500, "SKILL_DIR_MISSING", "Cannot find agents/services directory");
  }
  return found;
}

function loadCatalog(): SkillCatalog {
  const servicesRoot = resolveServicesRoot();
  const directories = readdirSync(servicesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const allSkills = directories
    .map((skillName) => {
      const skillDir = path.join(servicesRoot, skillName);
      const promptPath = path.join(skillDir, "prompt.md");
      const configPath = path.join(skillDir, "config.json");
      if (!existsSync(promptPath) || !existsSync(configPath)) {
        return undefined;
      }

      const prompt = readFileSync(promptPath, "utf8").trim();
      const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const config = skillConfigSchema.parse(rawConfig);
      const canonicalTaskType = config.taskTypes[0] ?? config.id;
      return {
        skillName,
        canonicalTaskType,
        prompt,
        config
      } satisfies LoadedSkill;
    })
    .filter((item): item is LoadedSkill => Boolean(item))
    .sort((a, b) => a.config.id.localeCompare(b.config.id));

  const enabledIds = new Set(writerConfig.serviceSkillIds.map((item) => normalizeKey(item)));
  const skills = enabledIds.size === 0
    ? allSkills.filter((skill) => skill.config.enabledByDefault)
    : allSkills.filter((skill) => enabledIds.has(normalizeKey(skill.config.id)));

  if (skills.length === 0) {
    throw new WriterError(
      500,
      "SKILL_NOT_FOUND",
      `No skills enabled for SERVICE_PROFILE=${writerConfig.serviceProfile}`,
      { requestedSkillIds: writerConfig.serviceSkillIds }
    );
  }

  const byKey = new Map<string, LoadedSkill>();
  for (const skill of skills) {
    const keys = [skill.skillName, skill.config.id, ...skill.config.taskTypes];
    for (const key of keys) {
      byKey.set(normalizeKey(key), skill);
    }
  }

  return { skills, byKey };
}

function getCatalog(): SkillCatalog {
  if (!cachedCatalog) {
    cachedCatalog = loadCatalog();
  }
  return cachedCatalog;
}

export function listLoadedSkills(): LoadedSkill[] {
  return getCatalog().skills.map((item) => ({
    skillName: item.skillName,
    canonicalTaskType: item.canonicalTaskType,
    prompt: item.prompt,
    config: {
      ...item.config,
      taskTypes: [...item.config.taskTypes],
      skills: [...item.config.skills]
    }
  }));
}

export function resolveSkillForTaskType(inputTaskType?: string): LoadedSkill {
  const requested = inputTaskType?.trim() || "content-generation";
  const skill = getCatalog().byKey.get(normalizeKey(requested));
  if (!skill) {
    const supported = getCatalog()
      .skills.map((item) => item.canonicalTaskType)
      .join(", ");
    throw new WriterError(400, "UNSUPPORTED_TASK_TYPE", `Unsupported taskType: ${requested}`, {
      supportedTaskTypes: supported
    });
  }
  return skill;
}

export function getSkillPriceWei(skill: LoadedSkill, fallbackPriceWei: string): string {
  return skill.config.priceWei ?? fallbackPriceWei;
}
