import type { AgentFeedback, AgentIdentity } from "./types.js";
import { getProcessPostgresStore } from "./storage-backend.js";

const identities = new Map<string, AgentIdentity>();
const feedbackByAgent = new Map<string, AgentFeedback[]>();

function normalizeIdentity(identity: AgentIdentity): AgentIdentity {
  const trustModels = [...new Set(identity.trustModels.filter((item) => item.trim().length > 0))];
  return {
    ...identity,
    trustModels,
    capabilities: identity.capabilities.map((item) => ({
      ...item,
      skills: item.skills ? [...item.skills] : undefined,
      tools: item.tools ? [...item.tools] : undefined
    }))
  };
}

export function registerAgentIdentity(identity: AgentIdentity): AgentIdentity {
  const normalized = normalizeIdentity(identity);
  identities.set(normalized.agentId, normalized);
  return normalized;
}

export function getAgentIdentity(agentId: string): AgentIdentity | undefined {
  const identity = identities.get(agentId);
  return identity ? normalizeIdentity(identity) : undefined;
}

export function listAgentIdentities(input: { activeOnly?: boolean } = {}): AgentIdentity[] {
  const items = [...identities.values()];
  const filtered = input.activeOnly ? items.filter((item) => item.active) : items;
  return filtered.map((item) => normalizeIdentity(item));
}

export function addAgentFeedback(feedback: AgentFeedback): AgentFeedback {
  const normalized: AgentFeedback = {
    ...feedback,
    value: Math.max(0, Math.min(100, Math.round(feedback.value))),
    tags: [...new Set(feedback.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
  };
  const list = feedbackByAgent.get(normalized.agentId) ?? [];
  list.push(normalized);
  feedbackByAgent.set(normalized.agentId, list);
  return normalized;
}

export function listAgentFeedback(agentId: string): AgentFeedback[] {
  const entries = feedbackByAgent.get(agentId) ?? [];
  return entries.map((item) => ({ ...item, tags: [...item.tags] }));
}

export function getAgentReputation(agentId: string): {
  count: number;
  average: number;
  latest?: AgentFeedback;
} {
  const entries = feedbackByAgent.get(agentId) ?? [];
  if (entries.length === 0) {
    return { count: 0, average: 0 };
  }
  const total = entries.reduce((sum, item) => sum + item.value, 0);
  const latest = entries[entries.length - 1];
  return {
    count: entries.length,
    average: Number((total / entries.length).toFixed(2)),
    latest: latest ? { ...latest, tags: [...latest.tags] } : undefined
  };
}

export async function persistAgentIdentity(identity: AgentIdentity): Promise<AgentIdentity> {
  const normalized = normalizeIdentity(identity);
  const postgres = await getProcessPostgresStore("agora-agent-registry");
  if (!postgres) return registerAgentIdentity(normalized);
  const result = await postgres.pool.query<{ identity: AgentIdentity }>(`
    INSERT INTO agent_identities (agent_id, identity, active, registered_at)
    VALUES ($1, $2::jsonb, $3, $4)
    ON CONFLICT (agent_id) DO UPDATE SET
      identity = EXCLUDED.identity || jsonb_build_object(
        'registeredAt', floor(extract(epoch FROM LEAST(
          agent_identities.registered_at, EXCLUDED.registered_at
        )))::bigint
      ),
      active = EXCLUDED.active,
      registered_at = LEAST(agent_identities.registered_at, EXCLUDED.registered_at),
      updated_at = clock_timestamp()
    RETURNING identity
  `, [
    normalized.agentId, JSON.stringify(normalized), normalized.active,
    new Date(normalized.registeredAt * 1_000)
  ]);
  return normalizeIdentity(result.rows[0].identity);
}

export async function getPersistedAgentIdentity(agentId: string): Promise<AgentIdentity | undefined> {
  const postgres = await getProcessPostgresStore("agora-agent-registry");
  if (!postgres) return getAgentIdentity(agentId);
  const result = await postgres.pool.query<{ identity: AgentIdentity }>(
    "SELECT identity FROM agent_identities WHERE agent_id = $1",
    [agentId]
  );
  return result.rows[0] ? normalizeIdentity(result.rows[0].identity) : undefined;
}

export async function listPersistedAgentIdentities(
  input: { activeOnly?: boolean } = {}
): Promise<AgentIdentity[]> {
  const postgres = await getProcessPostgresStore("agora-agent-registry");
  if (!postgres) return listAgentIdentities(input);
  const result = await postgres.pool.query<{ identity: AgentIdentity }>(`
    SELECT identity FROM agent_identities
    WHERE ($1::boolean = false OR active = true)
    ORDER BY registered_at, agent_id
  `, [Boolean(input.activeOnly)]);
  return result.rows.map((row) => normalizeIdentity(row.identity));
}
