'use client';

import { useState, useEffect, useCallback } from 'react';
import { onboard } from '@/lib/web3-onboard';

export interface WalletState {
    address: string | null;
    chainId: number | null;
    label: string | null;
    connected: boolean;
    connecting: boolean;
}

/**
 * Hook wrapping @web3-onboard/core for the Agora Mesh frontend.
 * Provides connect, disconnect, and reactive wallet state.
 */
export function useWallet() {
    const [state, setState] = useState<WalletState>({
        address: null,
        chainId: null,
        label: null,
        connected: false,
        connecting: false,
    });

    /* Subscribe to wallet state updates */
    useEffect(() => {
        const sub = onboard.state.select('wallets').subscribe((wallets) => {
            if (wallets.length > 0) {
                const w = wallets[0];
                const account = w.accounts[0];
                setState({
                    address: account?.address ?? null,
                    chainId: account?.address ? parseInt(w.chains[0]?.id ?? '0', 16) : null,
                    label: w.label,
                    connected: Boolean(account?.address),
                    connecting: false,
                });
            } else {
                setState({
                    address: null,
                    chainId: null,
                    label: null,
                    connected: false,
                    connecting: false,
                });
            }
        });

        return () => sub.unsubscribe();
    }, []);

    const connectAccount = useCallback(async (): Promise<string | null> => {
        setState((prev) => ({ ...prev, connecting: true }));
        try {
            const wallets = await onboard.connectWallet();
            if (wallets.length === 0) {
                setState((prev) => ({ ...prev, connecting: false }));
                return null;
            }
            // Return the connected account directly; React state updates on the next render.
            return wallets[0].accounts[0]?.address ?? null;
        } catch {
            setState((prev) => ({ ...prev, connecting: false }));
            return null;
        }
    }, []);

    const connect = useCallback(async () => Boolean(await connectAccount()), [connectAccount]);

    const disconnect = useCallback(async () => {
        const wallets = onboard.state.get().wallets;
        if (wallets.length > 0) {
            await onboard.disconnectWallet({ label: wallets[0].label });
        }
    }, []);

    return { ...state, connect, connectAccount, disconnect };
}
