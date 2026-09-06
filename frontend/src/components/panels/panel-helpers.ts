import { asRecord } from '@/lib/type-guards';
import type { AgentEvent, HunterRunResult, Money } from '@/types/agent';

/* ─── Types ─── */

export type MyAgentStatus = 'idle' | 'thinking' | 'paying' | 'verifying' | 'completed' | 'error';

export interface CommanderPhaseView {
    index: number;
    name: string;
    taskType: string;
    goal: string;
}

export interface CommanderBudget {
    maxTotal?: Money;
    maxPerPhase?: Money;
    maxPhases?: number;
    spent?: Money;
}

/* ─── Status display markers ─── */

export const STATUS_DISPLAY: Record<
    MyAgentStatus,
    { symbol: string; label: string; cls: string }
> = {
    idle: { symbol: '·', label: 'IDLE', cls: 'text-muted-foreground' },
    thinking: { symbol: '▸', label: 'THINKING', cls: 'text-primary text-glow animate-pulse' },
    paying: { symbol: '◎', label: 'PAYING', cls: 'text-amber-600 animate-pulse' },
    verifying: { symbol: '◈', label: 'VERIFYING', cls: 'text-cyan-600 animate-pulse' },
    completed: { symbol: '✓', label: 'COMPLETED', cls: 'text-green-600' },
    error: { symbol: '✗', label: 'ERROR', cls: 'text-red-600' },
};

/* ─── Arithmetic ─── */

export function addUnsignedIntegerStrings(a: string, b: string): string {
    let carry = 0;
    let i = a.length - 1;
    let j = b.length - 1;
    let out = '';
    while (i >= 0 || j >= 0 || carry > 0) {
        const da = i >= 0 ? Number(a[i]) : 0;
        const db = j >= 0 ? Number(b[j]) : 0;
        const sum = da + db + carry;
        out = String(sum % 10) + out;
        carry = Math.floor(sum / 10);
        i -= 1;
        j -= 1;
    }
    return out.replace(/^0+(?=\d)/, '');
}

/* ─── Event data extractors ─── */

export function readTotalPaymentAmount(events: AgentEvent[]): string | undefined {
    let total = '0';
    let hasValue = false;
    for (const event of events) {
        if (event.type !== 'quote_received' || typeof event.data !== 'object') continue;
        const amount = asRecord(event.data)?.amount;
        if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
        total = addUnsignedIntegerStrings(total, amount);
        hasValue = true;
    }
    return hasValue ? total : undefined;
}

export function readElapsedSeconds(events: AgentEvent[]): number | null {
    const started = events.find((e) => e.type === 'run_started');
    const ended = [...events].reverse().find((e) => e.type === 'run_completed' || e.type === 'run_failed');
    if (!started || !ended) return null;
    const s = new Date(started.at).getTime();
    const e = new Date(ended.at).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && e >= s ? Math.round((e - s) / 1000) : null;
}

/* ─── Commander phase helpers ─── */

export function collectCommanderPhases(
    events: AgentEvent[],
    result: HunterRunResult | null,
): CommanderPhaseView[] {
    const byIndex = new Map<number, CommanderPhaseView>();

    const decomposed = [...events].reverse().find((ev) => ev.type === 'mission_decomposed');
    const decomposedPhases = Array.isArray(asRecord(decomposed?.data)?.phases)
        ? (asRecord(decomposed?.data)?.phases as Array<Record<string, unknown>>)
        : [];
    for (const [index, phase] of decomposedPhases.entries()) {
        byIndex.set(index, {
            index,
            name: typeof phase.name === 'string' ? phase.name : `Phase ${index + 1}`,
            taskType: typeof phase.taskType === 'string' ? phase.taskType : '',
            goal: typeof phase.goal === 'string' ? phase.goal : '',
        });
    }

    for (const phase of result?.phases ?? []) {
        byIndex.set(phase.index, {
            index: phase.index,
            name: phase.phase.name,
            taskType: phase.phase.taskType,
            goal: phase.phase.goal,
        });
    }

    for (const event of events) {
        if (event.type !== 'phase_started' || typeof event.data !== 'object') continue;
        const data = asRecord(event.data);
        const index = typeof data?.index === 'number' ? data.index : -1;
        if (index < 0) continue;
        byIndex.set(index, {
            index,
            name: typeof data?.name === 'string' ? data.name : `Phase ${index + 1}`,
            taskType: typeof data?.taskType === 'string' ? data.taskType : '',
            goal: typeof data?.goal === 'string' ? data.goal : '',
        });
    }

    return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export function readCommanderBudget(
    events: AgentEvent[],
    result: HunterRunResult | null,
): CommanderBudget {
    if (result?.budget) return result.budget;

    const latestMission = [...events]
        .reverse()
        .find((ev) => ev.type === 'mission_decomposed' && typeof ev.data === 'object');
    const budgetRecord = asRecord(asRecord(latestMission?.data)?.budget);
    if (budgetRecord) {
        const maxTotal = readMoney(budgetRecord.maxTotal);
        const maxPerPhase = readMoney(budgetRecord.maxPerPhase);
        const spent = readMoney(budgetRecord.spent);
        return {
            maxTotal,
            maxPerPhase,
            maxPhases: typeof budgetRecord.maxPhases === 'number' ? budgetRecord.maxPhases : undefined,
            spent,
        };
    }

    const latestRun = [...events]
        .reverse()
        .find((ev) => ev.type === 'run_started' && typeof ev.data === 'object');
    const runData = asRecord(latestRun?.data);
    return {
        maxTotal: readMoney(runData?.maxTotal),
        maxPerPhase: readMoney(runData?.maxPerPhase),
        maxPhases: typeof runData?.maxPhases === 'number' ? runData.maxPhases : undefined,
    };
}

function readMoney(value: unknown): Money | undefined {
    const record = asRecord(value);
    const asset = asRecord(record?.asset);
    if (
        typeof record?.amount !== 'string' ||
        !/^\d+$/.test(record.amount) ||
        typeof asset?.chainId !== 'number' ||
        (asset.kind !== 'native' && asset.kind !== 'erc20') ||
        typeof asset.symbol !== 'string' ||
        typeof asset.decimals !== 'number'
    ) {
        return undefined;
    }
    return {
        amount: record.amount,
        asset: {
            chainId: asset.chainId,
            kind: asset.kind,
            address: typeof asset.address === 'string' && asset.address.startsWith('0x')
                ? asset.address as `0x${string}`
                : undefined,
            symbol: asset.symbol,
            decimals: asset.decimals,
        },
    };
}

export function readCommanderStatus(
    phases: CommanderPhaseView[],
    events: AgentEvent[],
    fallback: { symbol: string; label: string; cls: string },
    status: MyAgentStatus,
): { symbol: string; label: string; cls: string } {
    const total = phases.length;
    if (total <= 0) return fallback;

    const latestStarted = [...events]
        .reverse()
        .find((ev) => ev.type === 'phase_started' && typeof ev.data === 'object');
    const startedData = asRecord(latestStarted?.data);
    const startedIndex = typeof startedData?.index === 'number' ? startedData.index : 0;
    const startedName = typeof startedData?.name === 'string'
        ? startedData.name
        : phases.find((p) => p.index === startedIndex)?.name ?? 'Running';
    const startedOrder = phases.findIndex((p) => p.index === startedIndex);
    const current = startedOrder >= 0 ? startedOrder + 1 : Math.min(startedIndex + 1, total);

    if (status === 'completed') {
        return { symbol: '✓', label: `PHASE ${total}/${total}: COMPLETE`, cls: 'text-green-600' };
    }
    if (status === 'error') {
        return { symbol: '✗', label: `PHASE ${current}/${total}: FAILED`, cls: 'text-red-600' };
    }
    return {
        symbol: '◎',
        label: `PHASE ${current}/${total}: ${startedName.toUpperCase()}`,
        cls: 'text-amber-600 animate-pulse',
    };
}
