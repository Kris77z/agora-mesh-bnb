'use client';

/**
 * PipelineSnake — Global Commander pipeline visualization.
 *
 * Sits at the top of MissionTimeline (below NarrativeBar, above accordion).
 * The snake represents accumulating context: each Phase's selected agent
 * becomes a food → the snake hunts during execution wait → eats on success
 * → grows one segment longer per completed phase.
 *
 * State machine:
 *   phase_started           → new food appears
 *   execution_started       → snake enters 'hunt' mode (full-speed chase)
 *   phase_completed (ok)    → eat food, grow one segment
 *   phase_completed (fail)  → food turns red, snake turns away
 *   run_completed           → 'idle' mode, body keeps final length
 */

import { useEffect, useRef, useState } from 'react';
import type { SnakeNode, SnakeMode, SnakePersistentState } from './snake-engine';
import {
    CELL, SPEED_MS, IDLE_SPEED_MS, SELECTION_LOCK_MAX_MS,
    clamp, chooseIdleDirection, findTargetIndex,
    getDirectionToTarget, syncFoodsFromNodes, formatEatLabel, drawFrame,
    tickFoodCooldowns,
} from './snake-engine';

export type { SnakeNode, SnakeMode } from './snake-engine';

interface PipelineSnakeProps {
    nodes: SnakeNode[];
    activePhaseIndex: number;
    mode: SnakeMode;
}

export function PipelineSnake({ nodes, activePhaseIndex, mode }: PipelineSnakeProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [evalLabel, setEvalLabel] = useState('');
    const runtimeRef = useRef<SnakePersistentState | null>(null);
    const syncRequiredRef = useRef(true);
    const nodesRef = useRef(nodes);
    const modeRef = useRef<SnakeMode>(mode);
    const activePhaseRef = useRef(activePhaseIndex);

    /* Sync props into refs for the animation loop */
    useEffect(() => {
        nodesRef.current = nodes;
        modeRef.current = mode;
        activePhaseRef.current = activePhaseIndex;
        const runtime = runtimeRef.current;
        if (runtime?.selectionLockedPhase !== null && runtime) {
            if (activePhaseIndex > runtime.selectionLockedPhase!) {
                runtime.selectionLockedPhase = null;
                runtime.selectionLockedAt = null;
            }
        }
        syncRequiredRef.current = true;
    }, [nodes, mode, activePhaseIndex]);

    /* Canvas animation loop — runs once on mount */
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let width = container.clientWidth;
        let height = container.clientHeight;
        canvas.width = width;
        canvas.height = height;
        let cols = Math.floor(width / CELL);
        let rows = Math.floor(height / CELL);
        const centerY = Math.floor(rows / 2);

        if (!runtimeRef.current) {
            runtimeRef.current = {
                snake: [
                    { x: 2, y: centerY },
                    { x: 1, y: centerY },
                    { x: 0, y: centerY },
                ],
                dir: { x: 1, y: 0 },
                foods: [],
                idleTicks: 0,
                selectionLockedPhase: null,
                selectionLockedAt: null,
            };
        }

        let animId: number;
        let lastTime = 0;

        const render = (timestamp: number) => {
            animId = requestAnimationFrame(render);
            const tickMs = modeRef.current === 'idle' ? IDLE_SPEED_MS : SPEED_MS;
            if (timestamp - lastTime < tickMs) return;
            lastTime = timestamp;

            const runtime = runtimeRef.current;
            if (!runtime) return;

            if (syncRequiredRef.current) {
                syncFoodsFromNodes(runtime, nodesRef.current, cols, rows);
                syncRequiredRef.current = false;
            }

            /* Respawn foods whose cooldown has expired */
            tickFoodCooldowns(runtime);

            /* The lock normally lifts when the pipeline reaches the next phase.
               Runs that report no phase progression would hold it forever, so
               expire it and let the snake resume hunting the respawned foods. */
            if (
                runtime.selectionLockedAt !== null &&
                Date.now() - runtime.selectionLockedAt >= SELECTION_LOCK_MAX_MS
            ) {
                runtime.selectionLockedPhase = null;
                runtime.selectionLockedAt = null;
            }

            const phaseLock = runtime.selectionLockedPhase;
            const lockActive = phaseLock !== null && activePhaseRef.current <= phaseLock;
            const canHunt = modeRef.current === 'hunt' && !lockActive;

            const targetIdx = canHunt ? findTargetIndex(runtime.foods, activePhaseRef.current) : -1;
            const target = targetIdx >= 0 ? runtime.foods[targetIdx] : undefined;
            const head = runtime.snake[0];
            if (!head) return;

            /* Direction logic */
            if (target) {
                runtime.dir = getDirectionToTarget(head, target, runtime.dir);
            } else {
                if (runtime.idleTicks <= 0) {
                    runtime.dir = chooseIdleDirection(head, cols, rows, runtime.dir);
                    runtime.idleTicks = 3 + Math.floor(Math.random() * 6);
                } else {
                    runtime.idleTicks -= 1;
                }
            }

            let nextHead = { x: head.x + runtime.dir.x, y: head.y + runtime.dir.y };
            if (nextHead.x < 0 || nextHead.x >= cols || nextHead.y < 0 || nextHead.y >= rows) {
                runtime.dir = chooseIdleDirection(head, cols, rows, { x: -runtime.dir.x, y: -runtime.dir.y });
                nextHead = { x: head.x + runtime.dir.x, y: head.y + runtime.dir.y };
            }

            runtime.snake.unshift(nextHead);
            let ate = false;
            if (target && nextHead.x === target.x && nextHead.y === target.y) {
                target.eaten = true;
                target.cooldownUntil = Date.now() + 1500; // respawn after 1.5s
                ate = true;
                runtime.selectionLockedPhase = target.phaseIndex;
                runtime.selectionLockedAt = Date.now();
                setEvalLabel(formatEatLabel(target));
            }

            /* Grow only when eating a "selected" agent — represents absorbing capability */
            if (!ate) {
                runtime.snake.pop();
            } else if (target?.status !== 'selected') {
                runtime.snake.pop(); // skip (failed) foods don't add length
            }

            drawFrame(ctx, width, height, cols, rows, runtime.snake, runtime.foods, targetIdx, modeRef.current === 'idle');
        };

        /* Responsive: adjust on container resize */
        const ro = new ResizeObserver(() => {
            width = container.clientWidth;
            height = container.clientHeight;
            canvas.width = width;
            canvas.height = height;
            cols = Math.floor(width / CELL);
            rows = Math.floor(height / CELL);
            const runtime = runtimeRef.current;
            if (!runtime) return;
            for (const seg of runtime.snake) {
                seg.x = clamp(seg.x, 0, Math.max(0, cols - 1));
                seg.y = clamp(seg.y, 0, Math.max(0, rows - 1));
            }
            syncRequiredRef.current = true;
        });
        ro.observe(container);

        animId = requestAnimationFrame(render);
        return () => { cancelAnimationFrame(animId); ro.disconnect(); };
    }, []);

    if (nodes.length === 0) return null;

    return (
        <div ref={containerRef} className="relative w-full h-[80px] bg-[#f3f3f5] border border-border overflow-hidden">
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
            {evalLabel && (
                <div className="absolute bottom-1 left-2 text-[9px] font-mono text-foreground bg-card/80 px-1.5 py-0.5 border border-border">
                    {evalLabel}
                </div>
            )}
        </div>
    );
}
