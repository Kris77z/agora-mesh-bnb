/**
 * Snake game engine — pure logic & rendering for the Pipeline Snake.
 * No React dependency. Used by pipeline-snake.tsx.
 */
import { formatMON } from '@/lib/format';
import { publicChainConfig } from '@/lib/chain-config';

/* ─── Types ─── */

export type SnakeMode = 'hunt' | 'idle';
export type Point = { x: number; y: number };

export interface SnakeNode {
    key: string;
    phaseIndex: number;
    id: string;
    name: string;
    taskType?: string;
    price?: string;
    reputation: number;
    status: 'online' | 'selected' | 'failed';
}

export interface SnakeFood extends SnakeNode {
    x: number;
    y: number;
    eaten: boolean;
    /** Timestamp (ms) when food will respawn after being eaten */
    cooldownUntil: number;
}

export interface SnakePersistentState {
    snake: Point[];
    dir: Point;
    foods: SnakeFood[];
    idleTicks: number;
    selectionLockedPhase: number | null;
}

/* ─── Constants ─── */

export const CELL = 8;
export const SPEED_MS = 90;
export const IDLE_SPEED_MS = 160;

export const COLORS = {
    bg: '#f3f3f5',
    grid: '#e0e0e4',
    snake: '#0f766e',
    snakeBody: '#2dd4bf',
    foodDefault: '#9ca3af',    // gray — available
    foodTarget: '#22c55e',     // green — being hunted
    foodEaten: '#f59e0b',      // orange — just eaten
    text: '#19191d',
    muted: '#6e6e7a',
} as const;

/* ─── Helpers ─── */

/** Respawn any foods whose cooldown has expired */
export function tickFoodCooldowns(state: SnakePersistentState): void {
    const now = Date.now();
    for (const food of state.foods) {
        if (food.eaten && food.cooldownUntil > 0 && now >= food.cooldownUntil) {
            food.eaten = false;
            food.cooldownUntil = 0;
        }
    }
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function chooseIdleDirection(head: Point, cols: number, rows: number, current: Point): Point {
    const dirs: Point[] = [
        { x: 1, y: 0 }, { x: -1, y: 0 },
        { x: 0, y: 1 }, { x: 0, y: -1 },
    ];
    const valid = dirs.filter((d) => {
        const nx = head.x + d.x;
        const ny = head.y + d.y;
        return nx >= 0 && nx < cols && ny >= 0 && ny < rows;
    });
    if (valid.length === 0) return { x: -current.x || 1, y: -current.y };
    const keepCurrent = valid.find((d) => d.x === current.x && d.y === current.y);
    if (keepCurrent && Math.random() > 0.28) return keepCurrent;
    return valid[Math.floor(Math.random() * valid.length)];
}

export function findTargetIndex(foods: SnakeFood[], activePhaseIndex: number): number {
    const idx = foods.findIndex((f) => !f.eaten && f.phaseIndex <= activePhaseIndex);
    return idx >= 0 ? idx : foods.findIndex((f) => !f.eaten);
}

export function getDirectionToTarget(head: Point, target: Point, fallback: Point): Point {
    const dx = target.x - head.x;
    const dy = target.y - head.y;
    if (dx === 0 && dy === 0) return fallback;
    return Math.abs(dx) >= Math.abs(dy)
        ? { x: dx > 0 ? 1 : -1, y: 0 }
        : { x: 0, y: dy > 0 ? 1 : -1 };
}

/* ─── Sync foods from node data ─── */

export function syncFoodsFromNodes(
    state: SnakePersistentState,
    nodes: SnakeNode[],
    cols: number,
    rows: number,
): void {
    const byKey = new Map(state.foods.map((f) => [f.key, f]));
    const centerY = clamp(Math.floor(rows / 2), 1, Math.max(1, rows - 2));

    let newCount = 0;
    for (const node of nodes) {
        const existing = byKey.get(node.key);
        if (existing) {
            Object.assign(existing, {
                id: node.id, name: node.name, taskType: node.taskType,
                price: node.price, reputation: node.reputation,
                status: node.status, phaseIndex: node.phaseIndex,
            });
            continue;
        }
        const added: SnakeFood = {
            ...node, x: 0, y: 0, eaten: false, cooldownUntil: 0,
        };
        state.foods.push(added);
        byKey.set(node.key, added);
        newCount += 1;
    }

    if (newCount === 0 && state.foods.every((f) => f.x > 0)) return;

    state.foods.sort((a, b) =>
        a.phaseIndex !== b.phaseIndex ? a.phaseIndex - b.phaseIndex : a.key.localeCompare(b.key),
    );

    const margin = 4;
    const usable = Math.max(1, cols - margin * 2);
    const count = state.foods.length;
    const spacing = count > 1 ? Math.max(3, Math.floor(usable / count)) : 0;

    for (let i = 0; i < count; i++) {
        const food = state.foods[i];
        if (!food.eaten || food.x === 0) {
            food.x = clamp(margin + i * spacing, 1, Math.max(1, cols - 2));
            const yOffset = (i % 3) - 1;
            food.y = clamp(centerY + yOffset * 2, 1, Math.max(1, rows - 2));
        }
    }
}

/* ─── Eaten label formatter ─── */

export function formatEatLabel(food: SnakeFood): string {
    if (food.status === 'selected') {
        const price = food.price ? `${formatMON(food.price)} ${publicChainConfig.token}` : 'selected';
        return `✓ ${food.id} (${food.taskType ?? 'agent'}) → ${price}`;
    }
    return `✗ ${food.id} (${food.taskType ?? 'agent'}) → skip`;
}

/* ─── Canvas rendering ─── */

export function drawFrame(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    cols: number, rows: number,
    snake: Point[],
    foods: SnakeFood[],
    currentTarget: number,
    isIdle = false,
) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    /* Grid */
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.4;
    for (let x = 0; x <= cols; x++) {
        ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, rows * CELL); ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(cols * CELL, y * CELL); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* Foods — hidden while on cooldown */
    foods.forEach((food, i) => {
        if (food.eaten && food.cooldownUntil > 0) return; // invisible during cooldown

        const px = food.x * CELL;
        const py = food.y * CELL;

        if (food.eaten) {
            // Just-eaten flash: orange
            ctx.fillStyle = COLORS.foodEaten;
            ctx.globalAlpha = 0.8;
        } else if (i === currentTarget && currentTarget >= 0) {
            // Being targeted: pulsing green
            ctx.fillStyle = COLORS.foodTarget;
            ctx.globalAlpha = 0.7 + Math.sin(Date.now() * 0.008) * 0.3;
        } else {
            // Default: gray (available)
            ctx.fillStyle = COLORS.foodDefault;
            ctx.globalAlpha = 0.45;
        }
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
        ctx.globalAlpha = 1;

        /* Label below the food dot */
        ctx.fillStyle = food.eaten ? COLORS.foodEaten : COLORS.text;
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.globalAlpha = food.eaten ? 0.6 : 1;
        ctx.fillText(food.id.slice(0, 6), px + CELL / 2, py - 3);
        ctx.globalAlpha = 1;
    });

    /* Snake body */
    const alpha = isIdle ? 0.45 : 1;
    snake.forEach((seg, i) => {
        const px = seg.x * CELL;
        const py = seg.y * CELL;
        if (i === 0) {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = COLORS.snake;
            ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
        } else {
            ctx.globalAlpha = Math.max(0.2, 1 - (i / snake.length) * 0.8) * alpha;
            ctx.fillStyle = COLORS.snakeBody;
            ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
        }
        ctx.globalAlpha = 1;
    });
}
