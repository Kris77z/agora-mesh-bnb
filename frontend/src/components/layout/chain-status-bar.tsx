'use client';

import { useI18n } from '@/components/i18n/locale-provider';
import { formatLocaleNumber } from '@/lib/i18n';
import { publicChainConfig } from '@/lib/chain-config';
import { Blocks, Clock, Fuel, Wifi, WifiOff } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface ChainData {
    blockNumber: number | null;
    gasPrice: string | null;
    connected: boolean;
}

/** Fetch chain data via the server-side API proxy (avoids RPC CORS and URL leaks). */
async function fetchChainStatus(): Promise<{ blockNumber: number | null; gasGwei: string | null }> {
    const res = await fetch('/api/chain-status');
    if (!res.ok) throw new Error(`Chain status request failed (${res.status})`);
    return await res.json();
}

/**
 * Terminal-style chain status footer.
 * Polls the configured chain for real block number and gas price.
 */
export function ChainStatusBar() {
    const { locale, t } = useI18n();
    const [data, setData] = useState<ChainData>({
        blockNumber: null,
        gasPrice: null,
        connected: false,
    });

    const fetchChainData = useCallback(async () => {
        try {
            const res = await fetchChainStatus();
            setData({
                blockNumber: res.blockNumber,
                gasPrice: res.gasGwei,
                connected: res.blockNumber !== null,
            });
        } catch {
            setData((prev) => ({ ...prev, connected: false }));
        }
    }, []);

    useEffect(() => {
        fetchChainData();
        const interval = setInterval(fetchChainData, 12_000); // poll every 12s
        return () => clearInterval(interval);
    }, [fetchChainData]);

    return (
        <footer className="border-t border-border bg-card px-4 py-1.5 relative overflow-hidden">
            {/* Network pulse sweep */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-primary/5 to-transparent animate-monad-pulse" />
            </div>

            <div className="relative flex items-center justify-between text-[10px] text-muted-foreground">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                        <Blocks className="w-3 h-3" />
                        <span>
                            {t('chain.block')} #<span className="text-foreground">
                                {data.blockNumber !== null ? formatLocaleNumber(locale, data.blockNumber) : '...'}
                            </span>
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        <span>{publicChainConfig.averageBlockTimeLabel}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Fuel className="w-3 h-3" />
                        <span>
                            {t('chain.gas')}: <span className="text-foreground">
                                {data.gasPrice !== null ? `${data.gasPrice} gwei` : '...'}
                            </span>
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    {data.connected ? (
                        <>
                            <Wifi className="w-3 h-3 text-green-500" />
                            <span>{t('chain.connected')}</span>
                        </>
                    ) : (
                        <>
                            <WifiOff className="w-3 h-3 text-red-500" />
                            <span className="text-red-500">{t('chain.disconnected')}</span>
                        </>
                    )}
                </div>
            </div>
        </footer>
    );
}
