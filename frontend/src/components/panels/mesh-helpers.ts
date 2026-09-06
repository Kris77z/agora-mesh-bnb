import type { AgentEvent, HunterRunResult } from '@/types/agent';

/* ── Types ── */

export type AgentKind = 'writer' | 'auditor' | 'investigator' | 'defi' | 'gas' | 'scanner' | 'decoder' | 'abi' | 'yield' | 'unknown';

export interface MeshNode {
    id: string;
    name: string;
    endpoint?: string;
    price?: string;
    taskType?: string;
    reputation: number;
    reputationCount?: number;
    reputationTrend?: 'up' | 'down' | 'stable';
    reputationQualified?: boolean;
    lastUsedAt?: number;
    kind: AgentKind;
    status: 'online' | 'selected' | 'used' | 'failed';
    /** Number of times this agent was hired (service_selected) in the current session */
    hireCount: number;
}

export interface ServiceMeta {
    id: string;
    name?: string;
    taskType?: string;
    price?: string;
    reputation?: {
        score: number;
        count: number;
        trend: 'up' | 'down' | 'stable';
        qualified: boolean;
        lastUsedAt?: number;
    };
}

/* ── Constants ── */

export const AGENT_KIND_STYLE: Record<AgentKind, { marker: string; labelKey: string; cls: string }> = {
    writer: { marker: 'W', labelKey: 'mesh.kind.writer', cls: 'text-sky-700' },
    auditor: { marker: 'A', labelKey: 'mesh.kind.auditor', cls: 'text-amber-700' },
    investigator: { marker: 'R', labelKey: 'mesh.kind.investigator', cls: 'text-cyan-700' },
    defi: { marker: 'D', labelKey: 'mesh.kind.defi', cls: 'text-emerald-700' },
    gas: { marker: 'G', labelKey: 'mesh.kind.gas', cls: 'text-orange-600' },
    scanner: { marker: 'S', labelKey: 'mesh.kind.scanner', cls: 'text-red-600' },
    decoder: { marker: 'T', labelKey: 'mesh.kind.decoder', cls: 'text-indigo-600' },
    abi: { marker: 'I', labelKey: 'mesh.kind.abi', cls: 'text-violet-600' },
    yield: { marker: 'Y', labelKey: 'mesh.kind.yield', cls: 'text-teal-600' },
    unknown: { marker: '?', labelKey: 'mesh.kind.unknown', cls: 'text-muted-foreground' },
};

export const STATUS_TERMINAL: Record<MeshNode['status'], { marker: string; labelKey: string; cls: string }> = {
    online: { marker: '●', labelKey: 'mesh.status.online', cls: 'text-green-600' },
    selected: { marker: '◉', labelKey: 'mesh.status.selected', cls: 'text-primary text-glow' },
    used: { marker: '◌', labelKey: 'mesh.status.used', cls: 'text-sky-600' },
    failed: { marker: '✗', labelKey: 'mesh.status.failed', cls: 'text-red-600' },
};

export const TREND_STYLE: Record<'up' | 'down' | 'stable', { marker: string; cls: string }> = {
    up: { marker: '↑', cls: 'text-green-700' },
    down: { marker: '↓', cls: 'text-red-700' },
    stable: { marker: '→', cls: 'text-muted-foreground' },
};

/* ── Helpers ── */

function parseTrend(value: unknown): 'up' | 'down' | 'stable' {
    if (value === 'up' || value === 'down') return value;
    return 'stable';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readLastObjectData(events: AgentEvent[], type: string): Record<string, unknown> | undefined {
    const matched = [...events].reverse().find((e) => e.type === type && typeof e.data === 'object');
    return matched?.data && typeof matched.data === 'object' ? (matched.data as Record<string, unknown>) : undefined;
}

function toTitle(id: string): string {
    return id.replace(/-v\d+$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function classifyServiceKind(input: { taskType?: string; id?: string }): AgentKind {
    const t = input.taskType?.toLowerCase() ?? '';
    const id = input.id?.toLowerCase() ?? '';
    if (t.includes('investigation') || id.includes('investigator')) return 'investigator';
    if (t.includes('audit') || id.includes('audit')) return 'auditor';
    if (t.includes('gas') || id.includes('gas')) return 'gas';
    if (t.includes('token') || id.includes('scanner') || id.includes('token')) return 'scanner';
    if (t.includes('tx-decode') || id.includes('decoder') || t.includes('transaction')) return 'decoder';
    if (t.includes('abi') || id.includes('abi')) return 'abi';
    if (t.includes('yield') || id.includes('yield')) return 'yield';
    if (t.includes('defi') || id.includes('defi')) return 'defi';
    if (t.includes('content') || id.includes('writer') || t.includes('write')) return 'writer';
    return 'unknown';
}

export function reputationTierColor(score: number): string {
    if (score >= 3.5) return 'text-green-600';
    if (score >= 2.5) return 'text-yellow-600';
    if (score > 0) return 'text-red-500';
    return 'text-muted-foreground';
}

export function cardGlowClass(node: MeshNode): string {
    if (node.status === 'selected') return 'glow-border';
    if (node.status === 'used') return 'border-sky-500/40';
    if (node.status === 'failed') return 'border-red-300 opacity-60';
    if (node.reputation >= 4.0) return 'border-green-500/40';
    if (node.reputation > 0 && node.reputation < 2.5) return 'border-border opacity-50';
    return 'border-border';
}

/* ── Data parsing ── */

function parseReputation(raw: unknown): ServiceMeta['reputation'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    return {
        score: typeof obj.score === 'number' ? obj.score : 0,
        count: typeof obj.count === 'number' ? obj.count : 0,
        trend: parseTrend(obj.trend),
        qualified: Boolean(obj.qualified),
        lastUsedAt: typeof obj.lastUsedAt === 'number' ? obj.lastUsedAt : undefined,
    };
}

function parseDiscoveredServices(payload: Record<string, unknown> | undefined): ServiceMeta[] {
    if (!payload || !Array.isArray(payload.services)) return [];
    return payload.services
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
            id: typeof item.id === 'string' ? item.id : '',
            name: typeof item.name === 'string' ? item.name : undefined,
            taskType: typeof item.taskType === 'string' ? item.taskType : undefined,
            price: typeof item.price === 'string' ? item.price : undefined,
            reputation: parseReputation(item.reputation),
        }))
        .filter((item) => item.id.length > 0);
}

export function buildMeshNodes(events: AgentEvent[], result: HunterRunResult | null): MeshNode[] {
    const discoveredData = readLastObjectData(events, 'services_discovered');
    const selectedData = readLastObjectData(events, 'service_selected');
    const rawSelectedId = typeof selectedData?.id === 'string' ? selectedData.id : undefined;
    const selectedTaskType = typeof selectedData?.taskType === 'string' ? selectedData.taskType : undefined;

    // When mission is done, demote "selected" to "used"
    const missionDone = events.some((e) => e.type === 'run_completed' || e.type === 'run_failed');
    const selectedId = missionDone ? undefined : rawSelectedId;

    const usedIds = new Set(
        events
            .filter((event) => event.type === 'service_selected' && typeof event.data === 'object')
            .map((event) => asRecord(event.data)?.id)
            .filter((id): id is string => typeof id === 'string')
    );
    // Count how many times each agent was hired
    const hireCounts = new Map<string, number>();
    events
        .filter((event) => event.type === 'service_selected' && typeof event.data === 'object')
        .forEach((event) => {
            const id = asRecord(event.data)?.id;
            if (typeof id === 'string') hireCounts.set(id, (hireCounts.get(id) ?? 0) + 1);
        });
    if (selectedId) usedIds.delete(selectedId);

    const attempts = Array.isArray(selectedData?.attempts)
        ? (selectedData.attempts as Array<Record<string, unknown>>)
        : [];
    const failedIds = new Set(
        attempts.filter((a) => a.ok === false && typeof a.serviceId === 'string').map((a) => a.serviceId as string)
    );

    const discoveredIds = Array.isArray(discoveredData?.serviceIds)
        ? discoveredData.serviceIds.filter((id): id is string => typeof id === 'string')
        : [];
    const discoveredServices = parseDiscoveredServices(discoveredData);
    const metaById = new Map(discoveredServices.map((item) => [item.id, item]));

    const ids = new Set<string>(discoveredIds);
    if (rawSelectedId) ids.add(rawSelectedId);
    if (result?.service?.id) ids.add(result.service.id);
    for (const id of usedIds) ids.add(id);
    if (ids.size === 0) return [];

    return [...ids].map((id) => {
        const meta = metaById.get(id);
        const taskType =
            (rawSelectedId === id ? selectedTaskType : undefined) ??
            (result?.service?.id === id ? result.service.taskType : undefined) ??
            meta?.taskType;
        const reputation = meta?.reputation ?? (result?.service?.id === id ? result.service.reputation : undefined);
        return {
            id,
            name: (result?.service?.id === id ? result.service.name : undefined) ?? meta?.name ?? toTitle(id),
            endpoint: rawSelectedId === id && typeof selectedData?.endpoint === 'string'
                ? selectedData.endpoint
                : result?.service?.id === id ? result.service.endpoint : undefined,
            price: rawSelectedId === id && typeof selectedData?.price === 'string'
                ? selectedData.price
                : result?.service?.id === id ? result.service.price : meta?.price,
            taskType,
            reputation: reputation?.score ?? 0,
            reputationCount: reputation?.count,
            reputationTrend: reputation?.trend,
            reputationQualified: reputation?.qualified,
            lastUsedAt: reputation?.lastUsedAt,
            kind: classifyServiceKind({ id, taskType }),
            status: selectedId === id ? 'selected' : failedIds.has(id) ? 'failed' : usedIds.has(id) ? 'used' : 'online',
            hireCount: hireCounts.get(id) ?? 0,
        };
    });
}
