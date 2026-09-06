'use client';

import { useI18n } from '@/components/i18n/locale-provider';
import { useState, useEffect, useMemo } from 'react';
import { asRecord } from '@/lib/type-guards';
import { formatMON } from '@/lib/format';
import type { AgentEvent, HunterRunResult } from '@/types/agent';

interface NarrativeBarProps {
    events: AgentEvent[];
    result: HunterRunResult | null;
    isRunning: boolean;
    hasError: boolean;
}

/* ─── Event → human-readable sentence ─── */

/** Resolve a human-friendly agent name from nearby events */
function resolveAgentName(events: AgentEvent[], fallback: string): string {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type !== 'service_selected' && e.type !== 'execution_started') continue;
        const d = asRecord(e.data);
        // Prefer name from services_discovered
        const name = typeof d?.name === 'string' ? d.name : undefined;
        if (name) return name;
        // Fallback: look up name from earlier services_discovered
        const sid = typeof d?.id === 'string' ? d.id : (typeof d?.serviceId === 'string' ? d.serviceId : undefined);
        if (!sid) continue;
        for (let j = i - 1; j >= 0; j--) {
            if (events[j].type !== 'services_discovered') continue;
            const dd = asRecord(events[j].data);
            const svcs = Array.isArray(dd?.services) ? dd.services : [];
            const match = svcs.find((s) => asRecord(s)?.id === sid);
            if (match && typeof asRecord(match)?.name === 'string') return asRecord(match)!.name as string;
        }
        return sid;
    }
    return fallback;
}

function deriveNarrative(events: AgentEvent[], t: (key: string, variables?: Record<string, string | number>) => string): string {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const d = asRecord(e.data);
        switch (e.type) {
            case 'run_started':
                return t('narrative.runStarted');
            case 'mission_decomposed': {
                const phases = Array.isArray(d?.phases) ? d.phases : [];
                return t('narrative.decomposed', { count: phases.length });
            }
            case 'phase_started': {
                const name = typeof d?.name === 'string' ? d.name : 'running';
                const idx = typeof d?.index === 'number' ? d.index + 1 : '?';
                return t('narrative.phaseStarted', { index: idx, name });
            }
            case 'services_discovered': {
                const ids = Array.isArray(d?.serviceIds) ? d.serviceIds : [];
                const svcs = Array.isArray(d?.services) ? d.services : [];
                return t('narrative.scanning', { count: ids.length || svcs.length });
            }
            case 'service_selected': {
                const name = resolveAgentName(events, t('narrative.agentFallback'));
                return t('narrative.selected', { name });
            }
            case 'quote_received': {
                const amt = typeof d?.amount === 'string' ? formatMON(d.amount) : '?';
                return t('narrative.quote', { amount: amt });
            }
            case 'payment_state': {
                const st = typeof d?.status === 'string' ? d.status : '';
                if (st === 'payment-completed') return t('narrative.paymentSettled');
                return t('narrative.paymentSending');
            }
            case 'execution_started': {
                const name = resolveAgentName(events, t('narrative.agentFallback'));
                return t('narrative.working', { name });
            }
            case 'receipt_verified':
                return t('narrative.receiptVerified');
            case 'evaluation_completed': {
                const score = typeof d?.score === 'number' ? d.score : '?';
                return t('narrative.evaluated', { score });
            }
            case 'phase_completed': {
                const idx = typeof d?.index === 'number' ? d.index + 1 : '?';
                return t('narrative.phaseCompleted', { index: idx });
            }
            case 'run_completed':
                return t('narrative.completed');
            case 'run_failed':
                return t('narrative.failed');
            default:
                continue;
        }
    }
    return '';
}

/* ─── Live elapsed timer (ticks every second while running) ─── */

function useElapsedTimer(events: AgentEvent[], isRunning: boolean): number | null {
    const startTime = useMemo(() => {
        const ev = events.find((e) => e.type === 'run_started');
        return ev ? new Date(ev.at).getTime() : null;
    }, [events]);

    const [elapsed, setElapsed] = useState<number | null>(null);

    useEffect(() => {
        if (!startTime) { setElapsed(null); return; }

        if (!isRunning) {
            const end = [...events].reverse().find(
                (e) => e.type === 'run_completed' || e.type === 'run_failed',
            );
            if (end) {
                setElapsed(Math.round((new Date(end.at).getTime() - startTime) / 1000));
            }
            return;
        }

        const tick = () => setElapsed(Math.round((Date.now() - startTime) / 1000));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [startTime, isRunning, events]);

    return elapsed;
}

/* ─── Native-token spend total (for completion message) ─── */

function sumSpentWei(events: AgentEvent[]): string | undefined {
    const amounts = events
        .filter((e) => e.type === 'quote_received')
        .map((e) => asRecord(e.data)?.amount)
        .filter((a): a is string => typeof a === 'string' && /^\d+$/.test(a));
    if (amounts.length === 0) return undefined;
    return amounts.reduce((acc, v) => (BigInt(acc) + BigInt(v)).toString(), '0');
}

/* ─── Component ─── */

export function NarrativeBar({ events, result, isRunning, hasError }: NarrativeBarProps) {
    const { t } = useI18n();
    const elapsed = useElapsedTimer(events, isRunning);
    const narrative = deriveNarrative(events, t);

    /* Idle — no events yet */
    if (events.length === 0 && !result) {
        return <div className="px-1 py-2 mb-2 widget-label">─ {t('narrative.idle')}</div>;
    }

    /* Completed */
    if (!isRunning && result && !hasError) {
        const spent = sumSpentWei(events);
        return (
            <div className="px-1 py-2 mb-2 widget-label">
                <span className="text-green-600">✓</span>{' '}
                {t('narrative.done')}
                {elapsed !== null ? ` ${t('narrative.inSeconds', { seconds: elapsed })}` : ''}
                {spent ? ` · ${t('narrative.spent', { amount: formatMON(spent) })}` : ''}
            </div>
        );
    }

    /* Error */
    if (hasError && !isRunning) {
        return (
            <div className="px-1 py-2 mb-2 widget-label">
                <span className="text-red-600">✗</span> {t('narrative.failed')}
                {elapsed !== null && <span className="text-muted-foreground ml-1">[{elapsed}s]</span>}
            </div>
        );
    }

    /* Running — live narrative + elapsed timer */
    return (
        <div className="px-1 py-2 mb-2 widget-label">
            <span className="text-primary">⟩</span> {narrative || t('narrative.processing')}
            {elapsed !== null && (
                <span className="text-muted-foreground ml-2">[{elapsed}s]</span>
            )}
        </div>
    );
}
