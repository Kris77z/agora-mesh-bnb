'use client';

import { useI18n } from '@/components/i18n/locale-provider';
import { ResultView } from '@/components/agent/result-view';
import { cn } from '@/lib/utils';
import type { AgentEvent, HunterRunResult } from '@/types/agent';
import { motion, AnimatePresence } from 'motion/react';
import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { asRecord } from '@/lib/type-guards';

import type { PhaseId, PhaseStatus } from './phase-utils';
import { buildPhaseBuckets, mapEventToPhase, resolvePhaseStatus } from './phase-utils';
import { summaryForPhase } from './phase-summary';
import { buildCommanderTimeline, buildSnakeNodes } from './timeline-builders';
import { PipelineSnake } from './pipeline-snake';
import { NarrativeBar } from './narrative-bar';

/* ─── Phase definitions ─── */
const PHASES: Array<{ id: PhaseId; labelKey: string; icon: string }> = [
  { id: 'thinking', labelKey: 'timeline.phase.thinking', icon: '🧠' },
  { id: 'discovery', labelKey: 'timeline.phase.discovery', icon: '🔍' },
  { id: 'decision', labelKey: 'timeline.phase.decision', icon: '⚙️' },
  { id: 'payment', labelKey: 'timeline.phase.payment', icon: '💰' },
  { id: 'execution', labelKey: 'timeline.phase.execution', icon: '⚡' },
  { id: 'verification', labelKey: 'timeline.phase.verification', icon: '🔐' },
  { id: 'complete', labelKey: 'timeline.phase.complete', icon: '🏁' },
];

/* Terminal status markers */
const MARKER: Record<PhaseStatus, { symbol: string; cls: string }> = {
  pending: { symbol: '·', cls: 'text-muted-foreground' },
  active: { symbol: '▸', cls: 'text-primary text-glow animate-pulse' },
  done: { symbol: '✓', cls: 'text-green-600' },
  error: { symbol: '✗', cls: 'text-red-600' },
};

interface MissionTimelineProps {
  events: AgentEvent[];
  result: HunterRunResult | null;
  isRunning: boolean;
  hasError: boolean;
}

/* ─── Component ─── */
export function MissionTimeline({ events, result, isRunning, hasError }: MissionTimelineProps) {
  const { locale, t } = useI18n();
  const commanderPhases = useMemo(
    () => buildCommanderTimeline(events, result, isRunning, hasError),
    [events, result, isRunning, hasError]
  );
  const isCommanderView = commanderPhases.length > 0;
  const buckets = useMemo(() => buildPhaseBuckets(events), [events]);
  const latestPhase = useMemo(
    () => [...events].reverse().map(mapEventToPhase).find((p) => p !== null) ?? 'thinking',
    [events]
  );
  const latestPhaseIndex = PHASES.findIndex((p) => p.id === latestPhase);
  const latestStarted = useMemo(
    () =>
      [...events]
        .reverse()
        .find((event) => event.type === 'phase_started' && typeof event.data === 'object'),
    [events]
  );
  const activePhaseIndex = typeof asRecord(latestStarted?.data)?.index === 'number'
    ? (asRecord(latestStarted?.data)?.index as number)
    : 0;
  /* Snake hunts during the execution wait (30-90s).
     Goes idle during other phases or when not running. */
  const executionPhases: PhaseId[] = ['execution'];
  const hasExecutionStarted = events.some((e) => e.type === 'execution_started');
  const snakeMode = isRunning && (executionPhases.includes(latestPhase as PhaseId) || hasExecutionStarted)
    ? 'hunt' as const : 'idle' as const;

  /* Build snake nodes from events */
  const snakeNodes = useMemo(() => buildSnakeNodes(events, result), [events, result]);

  /* Focus expansion state — done phases collapse, click to expand */
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const togglePhase = useCallback((id: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  /* Empty state */
  if (events.length === 0 && !result) {
    return (
      <div className="h-full flex flex-col">
        <NarrativeBar events={events} result={result} isRunning={isRunning} hasError={hasError} />
        <div className="flex-1 border border-border bg-card flex items-center justify-center">
          <p className="text-xs text-muted-foreground">
            {t('timeline.awaiting')}<span className="cursor-blink">_</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <NarrativeBar events={events} result={result} isRunning={isRunning} hasError={hasError} />

      {/* Global Pipeline Snake — sits above all phase accordions */}
      {snakeNodes.length > 0 && (
        <div className="mb-2">
          <PipelineSnake nodes={snakeNodes} activePhaseIndex={activePhaseIndex} mode={snakeMode} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto pr-1 scrollbar-thin space-y-2">
        {/* Error banner */}
        {hasError && (
          <div className="border border-red-300 bg-red-50 p-2 text-xs text-red-700">
            ✗ {t('timeline.failed')}
          </div>
        )}

        {/* Phase entries — focus expansion: active=expanded, done=collapsed, pending=minimal */}
        {PHASES.map((phase, index) => {
          const phaseEvents = buckets[phase.id];
          const phaseStatus = resolvePhaseStatus({
            phaseId: phase.id,
            phaseIndex: index,
            latestPhaseIndex,
            hasEvents: phaseEvents.length > 0 || (phase.id === 'complete' && Boolean(result)),
            isRunning,
            hasError,
          });

          if (isCommanderView && phaseStatus === 'pending' && phaseEvents.length === 0) {
            if (!(phase.id === 'complete' && result)) return null;
          }

          const m = MARKER[phaseStatus];
          const isExpanded = phaseStatus === 'active'
            || phaseStatus === 'pending'
            || expandedPhases.has(phase.id);

          return (
            <motion.div
              key={phase.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                'border border-border bg-card transition-all',
                phaseStatus === 'pending' && 'opacity-50 p-3',
                phaseStatus === 'active' && 'phase-active-glow p-3',
                phaseStatus === 'done' && !expandedPhases.has(phase.id) && 'py-1.5 px-3 cursor-pointer hover:bg-card/80',
                phaseStatus === 'done' && expandedPhases.has(phase.id) && 'p-3 cursor-pointer',
                phaseStatus === 'error' && 'p-3',
              )}
              onClick={phaseStatus === 'done' || phaseStatus === 'error' ? () => togglePhase(phase.id) : undefined}
            >
              {/* Header line */}
              <div className="flex items-center justify-between text-xs">
                <span>{phase.icon} {t(phase.labelKey)}</span>
                <span className={cn(m.cls, phaseStatus === 'active' && 'terminal-active-blink')}>
                  [{m.symbol} {t(`timeline.phaseStatus.${phaseStatus}`)}]
                </span>
              </div>

              {/* Expandable content */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    key="detail"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="overflow-hidden"
                  >
                    <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                      {summaryForPhase(phase.id, phaseEvents, result, events, locale)}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}

        {/* ─── Independent Result Card ─── */}
        {!isRunning && result && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <ResultView result={result} />
            <Link href={`/tasks/${encodeURIComponent(result.missionId)}`} className="mt-2 flex items-center justify-center border border-border bg-card px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-muted/50">
              Open persistent task evidence →
            </Link>
          </motion.div>
        )}
      </div>
    </div>
  );
}
