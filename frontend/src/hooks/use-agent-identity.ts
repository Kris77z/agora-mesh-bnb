import { useState, useEffect, useCallback } from 'react';
import { apiBase } from '@/lib/api-config';
import { useI18n } from '@/components/i18n/locale-provider';

/* ─── Types matching backend GET /identity responses ─── */

export interface AgentCapability {
    type: 'mcp' | 'a2a' | 'oasf';
    endpoint?: string;
    skills?: string[];
    tools?: string[];
}

export interface AgentIdentity {
    agentId: string;
    name: string;
    description: string;
    image?: string;
    walletAddress: string;
    capabilities: AgentCapability[];
    trustModels: string[];
    active: boolean;
    registeredAt: number;
}

export interface OnchainStatus {
    registered: boolean;
    agentId?: string;
    txHash?: string;
}

export interface HunterIdentityResponse {
    identity: AgentIdentity;
    onchain?: OnchainStatus;
    balance?: {
        asset: { chainId: number; kind: 'native' | 'erc20'; address?: string; symbol: string; decimals: number };
        amount: string;
    };
    balanceFormatted?: string;
}

export interface WriterIdentityResponse {
    identity: AgentIdentity;
    service?: {
        id: string;
        name: string;
        endpoint: string;
        price: string;
    };
    onchain?: OnchainStatus;
}

/* ─── Hook ─── */

interface IdentityState {
    hunter: HunterIdentityResponse | null;
    writer: WriterIdentityResponse | null;
    loading: boolean;
    /** Per-service error messages for debugging */
    hunterError: string | null;
    writerError: string | null;
}

const IDENTITY_TIMEOUT_MS = 7000;

async function fetchIdentity<T>(url: string, t: (key: string, variables?: Record<string, string | number>) => string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);

    try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new Error(t('identity.timeout', { ms: IDENTITY_TIMEOUT_MS }));
        }
        if (error instanceof TypeError && /fetch/i.test(error.message)) {
            throw new Error(t('identity.offline'));
        }
        throw error instanceof Error ? error : new Error(String(error));
    } finally {
        clearTimeout(timer);
    }
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * Fetches Agent identity from Hunter and Writer `/identity` endpoints.
 * Shows real connection status instead of silent fallback.
 */
export function useAgentIdentity() {
    const { t } = useI18n();
    const [state, setState] = useState<IdentityState>({
        hunter: null,
        writer: null,
        loading: true,
        hunterError: null,
        writerError: null,
    });

    const fetchIdentities = useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true, hunterError: null, writerError: null }));

        const [hunterRes, writerRes] = await Promise.allSettled([
            fetchIdentity<HunterIdentityResponse>(`${apiBase.hunter}/identity`, t),
            fetchIdentity<WriterIdentityResponse>(`${apiBase.writer}/identity`, t),
        ]);

        setState({
            hunter: hunterRes.status === 'fulfilled' ? hunterRes.value : null,
            writer: writerRes.status === 'fulfilled' ? writerRes.value : null,
            loading: false,
            hunterError: hunterRes.status === 'rejected' ? toErrorMessage(hunterRes.reason) : null,
            writerError: writerRes.status === 'rejected' ? toErrorMessage(writerRes.reason) : null,
        });
    }, [t]);

    useEffect(() => {
        fetchIdentities().catch(() => { /* swallowed — errors handled inside */ });
    }, [fetchIdentities]);

    return { ...state, refresh: fetchIdentities };
}
