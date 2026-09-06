'use client';

import { Badge } from "@/components/ui/badge";
import { GoalInput } from "@/components/agent/goal-input";
import Link from "next/link";
import { Activity, ShieldCheck } from "lucide-react";
import type { StreamStatus } from "@/hooks/use-agent-stream";
import { publicChainConfig } from "@/lib/chain-config";

/**
 * 顶部 Header：Claura 暖色风格
 * Logo (Halant serif) + Network Badge + Mission Input
 */
export interface MeshHeaderProps {
    status: StreamStatus;
    onRun: (goal: string) => void;
}

export function MeshHeader({ status, onRun }: MeshHeaderProps) {
    return (
        <header className="border-b border-border bg-card/80 backdrop-blur-sm">
            {/* 顶部装饰条 — 暖色渐变 */}
            <div className="h-0.5 w-full bg-gradient-to-r from-warm-400/40 via-warm-600/50 to-warm-400/40 overflow-hidden">
                <div className="h-full w-1/3 bg-gradient-to-r from-warm-700 to-warm-500 animate-monad-pulse rounded-full" />
            </div>

            <div className="px-6 py-3">
                {/* 第一行：Logo + 状态 */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-md bg-warm-900 flex items-center justify-center shadow-sm">
                            <span className="text-xs font-black text-warm-100">A</span>
                        </div>
                        <h1 className="text-lg font-semibold tracking-tight text-foreground font-heading">
                            Agora Mesh
                        </h1>
                    </div>

                    <div className="flex items-center gap-3">
                        <Link href="/authority" className="hidden items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground sm:flex">
                            <ShieldCheck className="h-3.5 w-3.5" /> Authority
                        </Link>
                        <div className="hidden h-4 w-px bg-border sm:block" />
                        <Badge variant="secondary" className="gap-1.5 py-0.5 px-2.5 text-xs rounded-full">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" />
                            {publicChainConfig.label}
                        </Badge>
                        <div className="h-4 w-px bg-border" />
                        <div className="flex items-center gap-1.5">
                            <Activity className={`w-3.5 h-3.5 ${status === 'RUNNING' ? 'text-warm-800 animate-pulse' : 'text-muted-foreground'}`} />
                            <span className="font-mono text-xs text-muted-foreground">{status}</span>
                        </div>
                    </div>
                </div>

                {/* 第二行：GoalInput */}
                <GoalInput onRun={onRun} isLoading={status === 'RUNNING'} />
            </div>
        </header>
    );
}
