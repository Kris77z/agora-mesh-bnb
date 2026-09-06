'use client';

import type { HunterIdentityResponse } from '@/hooks/use-agent-identity';
import { useI18n } from '@/components/i18n/locale-provider';
import { shortenAddress } from '@/lib/format';
import { useState, useCallback } from 'react';
import { Loader2, RefreshCw, Copy, Check } from 'lucide-react';

interface AgentIdentityCardProps {
    identity: HunterIdentityResponse | null;
    identityLoading?: boolean;
    identityError?: string | null;
    onRetryIdentity?: () => void;
}

/**
 * Renders Hunter Agent identity: loading / error / connected states.
 * Connected state shows name, description, wallet address, and active-chain balance.
 */
export function AgentIdentityCard({
    identity, identityLoading, identityError, onRetryIdentity,
}: AgentIdentityCardProps) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);
    const walletAddr = identity?.identity?.walletAddress;
    const copyAddress = useCallback(() => {
        if (!walletAddr) return;
        void navigator.clipboard.writeText(walletAddr);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [walletAddr]);

    /* Loading */
    if (identityLoading) {
        return (
            <div className="border border-border bg-card p-4 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">{t('agent.connecting')}</span>
            </div>
        );
    }

    /* Error — only when no identity fallback */
    if (identityError && !identity) {
        return (
            <div className="border border-red-300 bg-red-50 p-3">
                <p className="text-xs text-red-700">✗ {t('agent.offline')}</p>
                <p className="text-[10px] text-red-500 mt-1 break-all">{identityError}</p>
                {onRetryIdentity && (
                    <button
                        onClick={onRetryIdentity}
                        className="mt-2 inline-flex items-center gap-1 text-[10px] text-red-600 hover:text-red-800"
                    >
                        <RefreshCw className="w-2.5 h-2.5" /> {t('agent.retry')}
                    </button>
                )}
            </div>
        );
    }

    /* Not connected yet */
    if (!identity) return null;

    /* Connected — identity header inside the parent card */
    return (
        <div>
            <p className="text-sm text-foreground">🤖 {identity.identity.name}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{identity.identity.description}</p>
            <div className="flex items-center gap-2 mt-1">
                {walletAddr && (
                    <button
                        onClick={copyAddress}
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                        title={walletAddr}
                    >
                        {shortenAddress(walletAddr)}
                        {copied ? <Check className="w-2.5 h-2.5 text-green-600" /> : <Copy className="w-2.5 h-2.5" />}
                    </button>
                )}
                {identity.balance && (
                    <span className="text-[10px] font-mono text-green-600/90">
                        {identity.balanceFormatted ?? '--'} {identity.balance.asset.symbol}
                    </span>
                )}
            </div>
        </div>
    );
}
