import type { AgentEvent, HunterRunResult } from '@/types/agent';
import type { LanguageCode } from '@/types/agent';
import type { PhaseId } from './phase-utils';
import { asRecord } from './phase-utils';
import { formatTokenAmount } from '@/lib/format';
import { translate } from '@/lib/i18n';

/**
 * Generate a human-readable summary for each timeline phase.
 */
export function summaryForPhase(
    phaseId: PhaseId,
    phaseEvents: AgentEvent[],
    result: HunterRunResult | null,
    allEvents: AgentEvent[] = phaseEvents,
    locale: LanguageCode = 'en-US',
): string {
    const compactText = (input: string, limit = 80): string => {
        const compact = input.replace(/\s+/g, ' ').trim();
        return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
    };

    const addUnsignedIntegerStrings = (a: string, b: string): string => {
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
    };

    const readTotalPaymentAmount = (): string | undefined => {
        let total = '0';
        let hasValue = false;
        for (const event of allEvents) {
            if (event.type !== 'quote_received' || typeof event.data !== 'object') continue;
            const amount = asRecord(event.data)?.amount;
            if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
            total = addUnsignedIntegerStrings(total, amount);
            hasValue = true;
        }
        return hasValue ? total : undefined;
    };

    /* The phase holding run_failed is the one that broke: show why, in place of
       that phase's normal summary. */
    const failure = [...phaseEvents].reverse().find((e) => e.type === 'run_failed');
    if (failure) {
        const message = asRecord(failure.data)?.message;
        if (typeof message === 'string' && message.trim()) {
            return translate(locale, 'timeline.summary.failed', { message: compactText(message, 120) });
        }
    }

    if (phaseId === 'thinking') {
        const run = phaseEvents.find((e) => e.type === 'run_started');
        const goal = typeof asRecord(run?.data)?.goal === 'string' ? (asRecord(run?.data)?.goal as string) : '';
        return goal
            ? translate(locale, 'timeline.summary.thinking.received', { goal })
            : translate(locale, 'timeline.summary.thinking.default');
    }

    if (phaseId === 'discovery') {
        const ev = [...phaseEvents].reverse().find((e) => e.type === 'services_discovered');
        const count = typeof asRecord(ev?.data)?.count === 'number' ? (asRecord(ev?.data)?.count as number) : 0;
        return count > 0
            ? translate(locale, 'timeline.summary.discovery.found', { count })
            : translate(locale, 'timeline.summary.discovery.default');
    }

    if (phaseId === 'decision') {
        const ev = [...phaseEvents].reverse().find((e) => e.type === 'service_selected');
        const data = asRecord(ev?.data);
        const id = typeof data?.id === 'string' ? data.id : typeof data?.serviceId === 'string' ? data.serviceId : '';
        const fb = typeof data?.fallbackFrom === 'string' ? data.fallbackFrom : '';
        if (id && fb && fb !== id) return translate(locale, 'timeline.summary.decision.switched', { from: fb, to: id });
        return id
            ? translate(locale, 'timeline.summary.decision.selected', { id })
            : translate(locale, 'timeline.summary.decision.default');
    }

    if (phaseId === 'payment') {
        const quote = [...phaseEvents].reverse().find((e) => e.type === 'quote_received');
        const pay = [...phaseEvents].reverse().find((e) => e.type === 'payment_state');
        const amount = typeof asRecord(quote?.data)?.amount === 'string' ? (asRecord(quote?.data)?.amount as string) : '';
        const status = typeof asRecord(pay?.data)?.status === 'string' ? (asRecord(pay?.data)?.status as string) : '';
        if (amount && status) return translate(locale, 'timeline.summary.payment.quotedStatus', { amount: formatTokenAmount(amount), status });
        if (amount) return translate(locale, 'timeline.summary.payment.quoted', { amount: formatTokenAmount(amount) });
        return translate(locale, 'timeline.summary.payment.default');
    }

    if (phaseId === 'execution') {
        if (result?.execution?.result) {
            return translate(locale, 'timeline.summary.execution.ready', { content: compactText(result.execution.result, 80) });
        }
        return translate(locale, 'timeline.summary.execution.default');
    }

    if (phaseId === 'verification') {
        if (result?.verification) {
            const summary = result.verification.report.summary;
            return translate(locale, 'timeline.summary.verification.independent', {
                confirmed: summary.confirmed,
                rejected: summary.rejected,
                missed: summary.missed,
            });
        }
        const receipt = [...phaseEvents].reverse().find((e) => e.type === 'receipt_verified');
        const evalEv = [...phaseEvents].reverse().find((e) => e.type === 'evaluation_completed');
        const verified = asRecord(receipt?.data)?.isValid === true;
        const score = typeof asRecord(evalEv?.data)?.score === 'number' ? (asRecord(evalEv?.data)?.score as number) : null;
        if (verified && score !== null) return translate(locale, 'timeline.summary.verification.verifiedScore', { score });
        const hasPaymentCompleted = allEvents.some(
            (e) => e.type === 'payment_state' && asRecord(e.data)?.status === 'payment-completed'
        );
        if (!receipt && hasPaymentCompleted) return translate(locale, 'timeline.summary.verification.awaiting');
        return verified
            ? translate(locale, 'timeline.summary.verification.verified')
            : translate(locale, 'timeline.summary.verification.default');
    }

    if (phaseId === 'complete') {
        const fromEvent = [...allEvents].reverse().find((e) => e.type === 'evaluation_completed');
        const score = typeof result?.evaluation?.score === 'number'
            ? result.evaluation.score
            : typeof asRecord(fromEvent?.data)?.score === 'number'
                ? (asRecord(fromEvent?.data)?.score as number)
                : null;
        const totalAmount = readTotalPaymentAmount();
        if (score !== null || totalAmount) {
            return translate(locale, 'timeline.summary.complete.closed', {
                score: score ?? '--',
                amount: formatTokenAmount(totalAmount),
            });
        }
        if (result?.finalMessage) {
            return compactText(result.finalMessage, 80);
        }
    }

    return result?.finalMessage
        ? compactText(result.finalMessage, 80)
        : translate(locale, 'timeline.summary.complete.default');
}
