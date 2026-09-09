import type { AgentEvent } from '@/types/agent';

/**
 * Phase IDs used by the Mission Timeline.
 */
export type PhaseId =
    | 'thinking'
    | 'discovery'
    | 'decision'
    | 'payment'
    | 'execution'
    | 'verification'
    | 'complete';

export type PhaseStatus = 'pending' | 'active' | 'done' | 'error';

/* ─── Utility ─── */

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
}

/* ─── Event → Phase mapping ─── */

export function mapEventToPhase(event: AgentEvent): PhaseId | null {
    if (event.type === 'run_started' || event.type === 'llm_response') return 'thinking';
    if (event.type === 'services_discovered') return 'discovery';
    if (event.type === 'service_selected') return 'decision';
    if (event.type === 'quote_received' || event.type === 'payment_state') return 'payment';

    if (event.type === 'execution_started') return 'execution';

    if (event.type === 'tool_call' || event.type === 'tool_result') {
        const data = asRecord(event.data);
        const tool = typeof data?.tool === 'string' ? data.tool : '';
        if (tool === 'submit_payment') return 'execution';
    }

    if (
        event.type === 'receipt_verified' ||
        event.type === 'evaluation_completed' ||
        event.type === 'feedback_submitted'
    ) {
        return 'verification';
    }

    if (event.type === 'run_completed') return 'complete';
    return null;
}

/* ─── Build phase buckets from raw events ─── */

export function buildPhaseBuckets(events: AgentEvent[]): Record<PhaseId, AgentEvent[]> {
    const buckets: Record<PhaseId, AgentEvent[]> = {
        thinking: [],
        discovery: [],
        decision: [],
        payment: [],
        execution: [],
        verification: [],
        complete: [],
    };

    let activePhase: PhaseId = 'thinking';
    for (const event of events) {
        const phase = mapEventToPhase(event);
        if (phase) {
            buckets[phase].push(event);
            activePhase = phase;
            continue;
        }
        /* run_failed carries the reason the run stopped but belongs to no phase of
           its own. File it under the phase that was running so the timeline shows
           what actually went wrong instead of dropping the message. */
        if (event.type === 'run_failed') buckets[activePhase].push(event);
    }
    return buckets;
}

/* ─── Resolve phase status ─── */

export function resolvePhaseStatus(input: {
    phaseId: PhaseId;
    phaseIndex: number;
    latestPhaseIndex: number;
    hasEvents: boolean;
    isRunning: boolean;
    hasError: boolean;
}): PhaseStatus {
    const { phaseId, phaseIndex, latestPhaseIndex, hasEvents, isRunning, hasError } = input;

    if (hasError && phaseId !== 'complete' && phaseIndex >= latestPhaseIndex) {
        return phaseIndex === latestPhaseIndex ? 'error' : 'pending';
    }
    if (!hasEvents && phaseIndex > latestPhaseIndex) return 'pending';
    if (phaseIndex < latestPhaseIndex) return 'done';

    if (phaseIndex === latestPhaseIndex) {
        if (isRunning && phaseId !== 'complete') return 'active';
        return hasEvents ? 'done' : 'pending';
    }
    if (phaseId === 'complete' && hasEvents) return 'done';
    return 'pending';
}
