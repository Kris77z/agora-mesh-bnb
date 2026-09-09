'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/api-config';

interface RegistryService {
    id: string;
    name: string;
    description?: string;
    endpoint?: string;
    taskType?: string;
    skills?: string[];
    price?: string;
    currency?: string;
    provider?: string;
    reputation?: {
        score: number;
        count: number;
        trend: 'up' | 'down' | 'stable';
        recentScores: number[];
        lastUsedAt: number;
        qualified: boolean;
    };
}

function parseTrend(value: unknown): 'up' | 'down' | 'stable' {
    if (value === 'up' || value === 'down') {
        return value;
    }
    return 'stable';
}

/** Fetch all services from the Registry API (GET /services) */
export function useRegistryServices() {
    const [services, setServices] = useState<RegistryService[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function fetchServices() {
            try {
                const res = await fetch(`${apiBase.registry}/services`, { signal: AbortSignal.timeout(15_000) });
                if (!res.ok) throw new Error('Registry request failed');

                const data = (await res.json()) as { services?: unknown[] };
                if (!Array.isArray(data.services)) throw new Error('Invalid service directory');

                const parsed = data.services
                    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
                    .map((item) => ({
                        id: String(item.id ?? ''),
                        name: String(item.name ?? item.id ?? ''),
                        description: typeof item.description === 'string' ? item.description : undefined,
                        endpoint: typeof item.endpoint === 'string' ? item.endpoint : undefined,
                        taskType: typeof item.taskType === 'string' ? item.taskType : undefined,
                        skills: Array.isArray(item.skills) ? item.skills.filter((s): s is string => typeof s === 'string') : undefined,
                        price: typeof item.price === 'string' ? item.price : undefined,
                        currency: typeof item.currency === 'string' ? item.currency : undefined,
                        provider: typeof item.provider === 'string' ? item.provider : undefined,
                        reputation:
                            item.reputation && typeof item.reputation === 'object'
                                ? {
                                    score: typeof (item.reputation as Record<string, unknown>).score === 'number'
                                        ? (item.reputation as Record<string, unknown>).score as number
                                        : 0,
                                    count: typeof (item.reputation as Record<string, unknown>).count === 'number'
                                        ? (item.reputation as Record<string, unknown>).count as number
                                        : 0,
                                    trend:
                                        parseTrend((item.reputation as Record<string, unknown>).trend),
                                    recentScores: Array.isArray((item.reputation as Record<string, unknown>).recentScores)
                                        ? ((item.reputation as Record<string, unknown>).recentScores as unknown[])
                                            .filter((value): value is number => typeof value === 'number')
                                        : [],
                                    lastUsedAt: typeof (item.reputation as Record<string, unknown>).lastUsedAt === 'number'
                                        ? (item.reputation as Record<string, unknown>).lastUsedAt as number
                                        : 0,
                                    qualified: Boolean((item.reputation as Record<string, unknown>).qualified),
                                }
                                : undefined,
                    }))
                    .filter((item) => item.id.length > 0);

                if (!cancelled) {
                    setServices(parsed);
                    setError(false);
                }
            } catch {
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        fetchServices();

        // Refresh every 30s
        const interval = setInterval(fetchServices, 30_000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    return { services, loading, error };
}
