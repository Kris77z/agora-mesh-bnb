'use client';

import { useI18n } from '@/components/i18n/locale-provider';
import { formatTokenAmount } from '@/lib/format';
import { formatDuration } from '@/lib/i18n';
import { useTypewriter } from '@/hooks/use-typewriter';
import { BudgetBar } from './payment-effects';

interface StatusDisplay {
    symbol: string;
    label: string;
    cls: string;
}

interface LiveRunStatsProps {
    status: StatusDisplay;
    spendAmount: string;
    budgetAmount?: string;
    budgetSpentAmount?: string;
    assetDecimals: number;
    assetSymbol: string;
    hasBudget: boolean;
    txCount: number;
    elapsed: number | null;
    mission?: string;
}

/**
 * Compact "LIVE RUN" stats block for the left panel.
 * Merges SPENT + BUDGET into a single visual, and embeds
 * the mission goal as a small text at the bottom.
 */
export function LiveRunStats({
    status, spendAmount, budgetAmount, budgetSpentAmount, assetDecimals, assetSymbol,
    hasBudget, txCount, elapsed, mission,
}: LiveRunStatsProps) {
    const { locale, t } = useI18n();
    const typedGoal = useTypewriter(mission, 20);

    return (
        <div className="space-y-1.5 text-xs">
            <p className="text-[10px] text-muted-foreground">{t('live.title')}</p>

            {/* Status */}
            <div className="flex justify-between">
                <span className="text-muted-foreground">{t('live.status')}</span>
                <span className={status.cls}>
                    [{status.symbol} {status.label}]
                </span>
            </div>

            {/* Spent + Budget merged */}
            {hasBudget && budgetAmount ? (
                <BudgetBar
                    spentAmount={budgetSpentAmount ?? spendAmount}
                    maxAmount={budgetAmount}
                    assetDecimals={assetDecimals}
                    assetSymbol={assetSymbol}
                />
            ) : (
                <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('live.spent')}</span>
                    <span>{formatTokenAmount(spendAmount, assetDecimals)} {assetSymbol}</span>
                </div>
            )}

            {/* TX count + Duration on same row to save space */}
            <div className="flex justify-between">
                <span className="text-muted-foreground">{t('live.txCount')}</span>
                <span>{txCount}</span>
            </div>
            <div className="flex justify-between">
                <span className="text-muted-foreground">{t('live.duration')}</span>
                <span>{formatDuration(locale, elapsed)}</span>
            </div>

            {/* Mission goal — compact inline */}
            {mission && (
                <div className="pt-1.5 border-t border-border/50">
                    <p className="text-[10px] text-muted-foreground mb-0.5">{t('live.goal')}</p>
                    <p className="text-[11px] text-foreground/80 leading-relaxed line-clamp-3">
                        &gt; {typedGoal}<span className="cursor-blink">_</span>
                    </p>
                </div>
            )}
        </div>
    );
}
