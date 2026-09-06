import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getProcessPostgresStore, type LanguageCode } from "@rebel/shared";

export interface LessonTranslations {
  "en-US"?: string;
  "zh-CN"?: string;
}

export interface Experience {
  missionId: string;
  goal: string;
  serviceUsed: string;
  taskType: string;
  score: number;
  lesson: string;
  lessonTranslations?: LessonTranslations;
  timestamp: number;
}

interface Insight {
  lesson: string;
  lessonTranslations?: LessonTranslations;
  count: number;
  taskTypes: string[];
  updatedAt: number;
}

interface ExperienceStore {
  experiences: Experience[];
}

interface InsightStore {
  insights: Insight[];
}

function resolveMemoryDir(): string {
  const base = process.env.INIT_CWD ?? process.cwd();
  return path.resolve(base, "agents/hunter/memory");
}

function experiencePath(): string {
  return path.join(resolveMemoryDir(), "experience.json");
}

function insightsPath(): string {
  return path.join(resolveMemoryDir(), "insights.json");
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function sanitizeLessonText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 200) : undefined;
}

function normalizeLessonTranslations(value: unknown): LessonTranslations | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const en = sanitizeLessonText(record["en-US"]);
  const zh = sanitizeLessonText(record["zh-CN"]);

  if (!en && !zh) {
    return undefined;
  }

  return {
    ...(en ? { "en-US": en } : {}),
    ...(zh ? { "zh-CN": zh } : {})
  };
}

function mergeLessonTranslations(
  current?: LessonTranslations,
  next?: LessonTranslations
): LessonTranslations | undefined {
  if (!current && !next) {
    return undefined;
  }

  const merged: LessonTranslations = {
    ...(current ?? {}),
    ...(next ?? {})
  };

  return merged["en-US"] || merged["zh-CN"] ? merged : undefined;
}

export function toLessonTranslations(
  locale: LanguageCode,
  lesson: string,
  existing?: LessonTranslations
): LessonTranslations {
  return {
    ...(existing ?? {}),
    [locale]: lesson
  };
}

export async function readExperiences(): Promise<Experience[]> {
  const postgres = await getProcessPostgresStore("agora-hunter-memory");
  const experiences = postgres
    ? await postgres.pool.query<{ experience: Experience }>(`
        SELECT experience FROM hunter_experiences
        ORDER BY occurred_at, experience_id
      `).then((result) => result.rows.map((row) => row.experience))
    : (await readJsonFile<ExperienceStore>(experiencePath(), { experiences: [] })).experiences;
  if (!Array.isArray(experiences)) return [];
  return experiences
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      missionId: String(item.missionId),
      goal: String(item.goal),
      serviceUsed: String(item.serviceUsed),
      taskType: String(item.taskType),
      score: Number(item.score),
      lesson: String(item.lesson),
      lessonTranslations: normalizeLessonTranslations(
        (item as { lessonTranslations?: unknown }).lessonTranslations
      ),
      timestamp: Number(item.timestamp)
    }))
    .filter((item) => item.lesson.trim().length > 0);
}

async function writeExperiences(experiences: Experience[]): Promise<void> {
  await writeJsonFile(experiencePath(), { experiences });
}

function normalizeLessonKey(lesson: string): string {
  return lesson.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildInsights(experiences: Experience[]): Insight[] {
  const byLesson = new Map<
    string,
    {
      lesson: string;
      lessonTranslations?: LessonTranslations;
      count: number;
      taskTypes: Set<string>;
      updatedAt: number;
    }
  >();

  for (const exp of experiences) {
    const key = normalizeLessonKey(exp.lesson);
    const existing = byLesson.get(key);
    if (!existing) {
      byLesson.set(key, {
        lesson: exp.lesson.trim(),
        lessonTranslations: exp.lessonTranslations,
        count: 1,
        taskTypes: new Set([exp.taskType]),
        updatedAt: exp.timestamp
      });
      continue;
    }
    existing.lessonTranslations = mergeLessonTranslations(existing.lessonTranslations, exp.lessonTranslations);
    existing.count += 1;
    existing.taskTypes.add(exp.taskType);
    existing.updatedAt = Math.max(existing.updatedAt, exp.timestamp);
  }

  return [...byLesson.values()]
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, 20)
    .map((item) => ({
      lesson: item.lesson,
      lessonTranslations: item.lessonTranslations,
      count: item.count,
      taskTypes: [...item.taskTypes],
      updatedAt: item.updatedAt
    }));
}

async function writeInsights(insights: Insight[]): Promise<void> {
  await writeJsonFile(insightsPath(), { insights });
}

async function readInsights(): Promise<Insight[]> {
  const postgres = await getProcessPostgresStore("agora-hunter-memory");
  if (postgres) return buildInsights(await readExperiences());
  const store = await readJsonFile<InsightStore>(insightsPath(), { insights: [] });
  if (!Array.isArray(store.insights)) {
    return [];
  }
  return store.insights
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      lesson: String(item.lesson),
      lessonTranslations: normalizeLessonTranslations(
        (item as { lessonTranslations?: unknown }).lessonTranslations
      ),
      count: Number(item.count),
      taskTypes: Array.isArray(item.taskTypes) ? item.taskTypes.map((taskType) => String(taskType)) : [],
      updatedAt: Number(item.updatedAt)
    }))
    .filter((item) => item.lesson.trim().length > 0 && Number.isFinite(item.count) && item.count > 0);
}

export async function appendExperience(experience: Experience): Promise<Experience> {
  const postgres = await getProcessPostgresStore("agora-hunter-memory");
  if (postgres) {
    const contentHash = createHash("sha256").update(JSON.stringify(experience)).digest("hex");
    const client = await postgres.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agora_hunter_memory'))");
      await client.query(`
        INSERT INTO hunter_experiences (
          experience_id, content_hash, mission_id, experience, occurred_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (content_hash) DO NOTHING
      `, [
        randomUUID(), contentHash, experience.missionId, JSON.stringify(experience),
        new Date(experience.timestamp * 1_000)
      ]);
      await client.query(`
        DELETE FROM hunter_experiences
        WHERE experience_id NOT IN (
          SELECT experience_id FROM hunter_experiences
          ORDER BY occurred_at DESC, experience_id DESC
          LIMIT 200
        )
      `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return experience;
  }
  const all = await readExperiences();
  const next = [...all, experience]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-200);
  await writeExperiences(next);
  await writeInsights(buildInsights(next));
  return experience;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3)
  );
}

function scoreExperience(exp: Experience, goalTokens: Set<string>, taskType?: string): number {
  let score = 0;
  if (taskType && exp.taskType === taskType) {
    score += 5;
  }

  const expTokens = tokenize(`${exp.goal} ${exp.lesson} ${exp.taskType} ${exp.serviceUsed}`);
  for (const token of goalTokens) {
    if (expTokens.has(token)) {
      score += 1;
    }
  }

  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - exp.timestamp);
  const agePenalty = Math.min(5, ageSeconds / (24 * 3600 * 7));
  score -= agePenalty;
  return score;
}

export async function buildMemoryPrompt(input: {
  goal: string;
  taskType?: string;
  maxExperiences?: number;
}): Promise<string> {
  const [experiences, insights] = await Promise.all([readExperiences(), readInsights()]);
  if (experiences.length === 0 && insights.length === 0) {
    return "No prior mission memory available.";
  }

  const maxExperiences = input.maxExperiences ?? 3;
  const goalTokens = tokenize(input.goal);
  const relevant = [...experiences]
    .sort((a, b) => scoreExperience(b, goalTokens, input.taskType) - scoreExperience(a, goalTokens, input.taskType))
    .slice(0, maxExperiences);

  const topInsights = insights.slice(0, 3);

  const sections: string[] = [];
  if (relevant.length > 0) {
    sections.push("Past experiences:");
    sections.push(
      ...relevant.map(
        (item, index) =>
          `${index + 1}. taskType=${item.taskType}; service=${item.serviceUsed}; score=${item.score}; lesson=${item.lesson}`
      )
    );
  }
  if (topInsights.length > 0) {
    sections.push("Consolidated insights:");
    sections.push(
      ...topInsights.map(
        (item, index) =>
          `${index + 1}. ${item.lesson} (seen ${item.count} times; taskTypes=${item.taskTypes.join(",")})`
      )
    );
  }
  return sections.join("\n");
}
