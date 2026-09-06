'use client';

import { useState, useEffect, useCallback } from 'react';

export interface MissionRecord {
    id: string;
    goal: string;
    status: 'completed' | 'error';
    timestamp: number;
    duration?: number; // seconds
    spentAmount?: string;
    assetSymbol?: string;
    assetDecimals?: number;
    serviceName?: string;
    score?: number;
}

const STORAGE_KEY = 'rebel_mission_history';
const MAX_RECORDS = 50;

/** Read mission history from localStorage */
function loadHistory(): MissionRecord[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Array<MissionRecord & { spentWei?: string }>;
        return parsed.map(({ spentWei, ...record }) => ({
            ...record,
            spentAmount: record.spentAmount ?? spentWei,
        }));
    } catch {
        return [];
    }
}

/** Save mission history to localStorage */
function saveHistory(records: MissionRecord[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
    } catch { /* storage full — silently ignore */ }
}

/**
 * Hook to manage mission execution history.
 * Stores up to 50 records in localStorage.
 */
export function useMissionHistory() {
    const [history, setHistory] = useState<MissionRecord[]>([]);

    // Load on mount
    useEffect(() => {
        setHistory(loadHistory());
    }, []);

    /** Add a completed mission to history */
    const addRecord = useCallback((record: Omit<MissionRecord, 'id' | 'timestamp'>) => {
        setHistory((prev) => {
            const newRecord: MissionRecord = {
                ...record,
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: Date.now(),
            };
            const updated = [newRecord, ...prev].slice(0, MAX_RECORDS);
            saveHistory(updated);
            return updated;
        });
    }, []);

    /** Clear all history */
    const clearHistory = useCallback(() => {
        setHistory([]);
        localStorage.removeItem(STORAGE_KEY);
    }, []);

    return { history, addRecord, clearHistory };
}
