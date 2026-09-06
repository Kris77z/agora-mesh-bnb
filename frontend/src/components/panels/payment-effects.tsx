'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { asRecord } from '@/lib/type-guards';
import { formatTokenAmount } from '@/lib/format';
import { publicChainConfig } from '@/lib/chain-config';
import type { AgentEvent } from '@/types/agent';

/* ─── Budget Bar (血条) ─── */

interface BudgetBarProps {
    spentAmount?: string;
    maxAmount?: string;
    assetDecimals?: number;
    assetSymbol?: string;
}

export function BudgetBar({
    spentAmount,
    maxAmount,
    assetDecimals = 18,
    assetSymbol = publicChainConfig.token,
}: BudgetBarProps) {
    const spent = BigInt(spentAmount ?? '0');
    const max = BigInt(maxAmount ?? '0');
    const pct = max > BigInt(0)
        ? Math.min(100, Number((spent * BigInt(10_000)) / max) / 100)
        : 0;

    /* Shake when budget decreases */
    const [shake, setShake] = useState(false);
    const prevPct = useRef(pct);
    useEffect(() => {
        if (pct > prevPct.current && prevPct.current > 0) {
            setShake(true);
            const t = setTimeout(() => setShake(false), 400);
            return () => clearTimeout(t);
        }
        prevPct.current = pct;
    }, [pct]);

    if (!maxAmount) return null;

    /* Color based on how much budget is consumed */
    const barColor = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-amber-500' : 'bg-red-500';

    return (
        <div className={shake ? 'animate-shake' : ''}>
            <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>SPENT</span>
                <span>{formatTokenAmount(spentAmount, assetDecimals)} / {formatTokenAmount(maxAmount, assetDecimals)} {assetSymbol}</span>
            </div>
            <div className="h-1.5 bg-border rounded-full overflow-hidden">
                <motion.div
                    className={`h-full ${barColor} rounded-full`}
                    initial={{ width: '0%' }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                />
            </div>
        </div>
    );
}

/* ─── Payment Strike (盖章动画) ─── */

interface PaymentStrikeProps {
    events: AgentEvent[];
}

export function PaymentStrike({ events }: PaymentStrikeProps) {
    const [visible, setVisible] = useState(false);
    const [amountText, setAmountText] = useState('');
    const lastPaymentId = useRef<string | null>(null);

    /* Detect new payment-completed events */
    const latestPayment = useMemo(() => {
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (e.type !== 'payment_state') continue;
            const d = asRecord(e.data);
            if (d?.status !== 'payment-completed') continue;
            const txHash = typeof d?.txHash === 'string' ? d.txHash : '';
            return { id: `${e.at}-${txHash}`, amount: typeof d?.amount === 'string' ? d.amount : undefined };
        }
        return null;
    }, [events]);

    useEffect(() => {
        if (!latestPayment || latestPayment.id === lastPaymentId.current) return;
        lastPaymentId.current = latestPayment.id;
        setAmountText(latestPayment.amount
            ? `-${formatTokenAmount(latestPayment.amount)} ${publicChainConfig.token}`
            : 'PAID');
        setVisible(true);
        const t = setTimeout(() => setVisible(false), 2000);
        return () => clearTimeout(t);
    }, [latestPayment]);

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    key={lastPaymentId.current}
                    className="fixed inset-0 flex items-center justify-center pointer-events-none z-50"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    {/* Stamp effect */}
                    <motion.div
                        className="flex flex-col items-center gap-2"
                        initial={{ scale: 2.5, opacity: 0, rotate: -15 }}
                        animate={{ scale: 1, opacity: 1, rotate: 0 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                    >
                        <span className="text-3xl font-bold text-green-500 tracking-widest drop-shadow-lg">
                            TX CONFIRMED
                        </span>
                        <span className="text-lg text-green-400/80 font-mono">
                            {amountText}
                        </span>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
