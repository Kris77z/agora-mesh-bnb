import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentFeedback } from "./types.js";
import { getProcessPostgresStore } from "./storage-backend.js";

interface FeedbackStoreFile {
  feedback: AgentFeedback[];
}

const defaultFeedbackStorePath = path.resolve(
  process.env.INIT_CWD ?? process.cwd(),
  process.env.FEEDBACK_STORE_PATH ?? "./registry/feedback-store.json"
);

async function readFeedbackStore(): Promise<FeedbackStoreFile> {
  try {
    const content = await readFile(defaultFeedbackStorePath, "utf8");
    const parsed = JSON.parse(content) as FeedbackStoreFile;
    if (!Array.isArray(parsed.feedback)) {
      return { feedback: [] };
    }
    return {
      feedback: parsed.feedback
    };
  } catch (error) {
    const asNodeError = error as NodeJS.ErrnoException;
    if (asNodeError.code === "ENOENT") {
      return { feedback: [] };
    }
    throw error;
  }
}

async function writeFeedbackStore(payload: FeedbackStoreFile): Promise<void> {
  await mkdir(path.dirname(defaultFeedbackStorePath), { recursive: true });
  await writeFile(defaultFeedbackStorePath, JSON.stringify(payload, null, 2), "utf8");
}

export async function appendFeedbackStoreEntry(feedback: AgentFeedback): Promise<void> {
  const postgres = await getProcessPostgresStore("agora-agent-feedback");
  if (postgres) {
    await postgres.appendAgentFeedback({
      agentId: feedback.agentId,
      reviewer: feedback.reviewer,
      value: feedback.value,
      tags: feedback.tags,
      text: feedback.text,
      createdAt: new Date(feedback.timestamp * 1_000)
    });
    return;
  }
  const store = await readFeedbackStore();
  store.feedback.push(feedback);
  await writeFeedbackStore(store);
}

export async function listFeedbackStoreEntries(agentId: string): Promise<AgentFeedback[]> {
  const postgres = await getProcessPostgresStore("agora-agent-feedback");
  if (postgres) {
    return (await postgres.listAgentFeedback(agentId)).map((entry) => ({
      agentId: entry.agentId,
      reviewer: entry.reviewer,
      value: entry.value,
      tags: entry.tags,
      ...(entry.text ? { text: entry.text } : {}),
      timestamp: Math.floor(Date.parse(entry.createdAt) / 1_000)
    }));
  }
  const store = await readFeedbackStore();
  return store.feedback.filter((item) => item.agentId === agentId);
}

export async function getFeedbackStoreReputation(agentId: string): Promise<{
  count: number;
  average: number;
  latest?: AgentFeedback;
}> {
  const entries = await listFeedbackStoreEntries(agentId);
  if (entries.length === 0) {
    return { count: 0, average: 0 };
  }
  const total = entries.reduce((sum, item) => sum + item.value, 0);
  return {
    count: entries.length,
    average: Number((total / entries.length).toFixed(2)),
    latest: entries[entries.length - 1]
  };
}
