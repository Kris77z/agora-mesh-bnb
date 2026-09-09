'use client';

import { useI18n } from '@/components/i18n/locale-provider';
import { cn } from '@/lib/utils';
import { formatMON } from '@/lib/format';
import { servicePaymentSymbol } from '@/lib/chain-config';
import { formatRelativeUnixTime } from '@/lib/i18n';
import { motion } from 'motion/react';
import { useRegistryServices } from '@/hooks/use-registry-services';
import type { AgentEvent, HunterRunResult } from '@/types/agent';
import { RepImpactFloater, useIsScanning } from './rep-impact';
import { HireStamp } from './hire-stamp';
import {
  AGENT_KIND_STYLE,
  STATUS_TERMINAL,
  TREND_STYLE,
  buildMeshNodes,
  cardGlowClass,
  classifyServiceKind,
  reputationTierColor,
  type MeshNode,
} from './mesh-helpers';

interface AgentMeshPanelProps {
  events: AgentEvent[];
  result: HunterRunResult | null;
}

function ReputationBar({ value }: { value: number }) {
  const filled = Math.round((value / 5) * 8);
  const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);
  return <span className={reputationTierColor(value)}>{bar} {value.toFixed(1)}</span>;
}

export function AgentMeshPanel({ events, result }: AgentMeshPanelProps) {
  const { locale, t } = useI18n();
  const { services: registryServices } = useRegistryServices();
  const eventNodes = buildMeshNodes(events, result);
  const eventNodeIds = new Set(eventNodes.map((n) => n.id));
  const isScanning = useIsScanning(events);

  // Merge: event nodes first (with status), then remaining registry services
  const registryOnlyNodes: MeshNode[] = registryServices
    .filter((s) => !eventNodeIds.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      endpoint: s.endpoint,
      price: s.price,
      taskType: s.taskType,
      reputation: s.reputation?.score ?? 0,
      reputationCount: s.reputation?.count,
      reputationTrend: s.reputation?.trend,
      reputationQualified: s.reputation?.qualified,
      lastUsedAt: s.reputation?.lastUsedAt,
      kind: classifyServiceKind({ id: s.id, taskType: s.taskType }),
      status: 'online' as const,
      hireCount: 0,
    }));

  // Sort: selected/used/failed first, then by reputation descending
  const allNodes = [...eventNodes, ...registryOnlyNodes];
  const statusWeight = (s: MeshNode['status']) =>
    s === 'selected' ? 3 : s === 'used' ? 2 : s === 'failed' ? 1 : 0;
  const nodes = allNodes.sort((a, b) => {
    const sw = statusWeight(b.status) - statusWeight(a.status);
    if (sw !== 0) return sw;
    return b.reputation - a.reputation;
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-1 py-2 mb-2 widget-label">─ {t('mesh.title')}</div>

      <div className="space-y-3 flex-1 overflow-y-auto pr-1 scrollbar-thin">
        {nodes.map((node) => {
          const st = STATUS_TERMINAL[node.status];
          const kind = AGENT_KIND_STYLE[node.kind];
          const trend = TREND_STYLE[node.reputationTrend ?? 'stable'];
          const isSelected = node.status === 'selected';
          const isUsed = node.status === 'used';
          return (
            <motion.div
              key={node.id}
              layout
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              className="relative"
            >
              {/* Rep impact floater */}
              {(isUsed || isSelected) && (
                <RepImpactFloater events={events} nodeId={node.id} />
              )}

              <div
                className={cn(
                  'relative border bg-card p-3 transition-all',
                  cardGlowClass(node),
                  isSelected && 'agent-hired-glow',
                  !isSelected && isScanning && 'agent-scanning',
                )}
              >
                {/* Circular hire stamp (inside the card) */}
                <HireStamp count={node.hireCount} />

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{node.name}</p>
                  </div>
                  <span className={cn('text-[10px] shrink-0', st.cls)}>[{st.marker} {t(st.labelKey)}]</span>
                </div>

                <div className="mt-2 text-[10px]">
                  <span className={cn(kind.cls)}>{t(kind.labelKey)}</span>
                  {node.taskType && <span className="text-muted-foreground"> · {node.taskType}</span>}
                </div>

                <div className="mt-3 space-y-1 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('mesh.price')}</span>
                    <span>{formatMON(node.price)} {registryServices.find((service) => service.id === node.id)?.currency || servicePaymentSymbol}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t('mesh.rep')}</span>
                    <ReputationBar value={node.reputation} />
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t('mesh.samples')}</span>
                    {node.reputationQualified === false ? (
                      <motion.span
                        className="text-[10px] text-muted-foreground"
                        animate={{ opacity: [0.4, 1, 0.4] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                      >
                        {node.reputationCount ?? 0} · {t('mesh.warmingUp')}
                      </motion.span>
                    ) : (
                      <span className={cn('text-[10px]', trend.cls)}>
                        {node.reputationCount ?? 0} {trend.marker}
                      </span>
                    )}
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t('mesh.lastUsed')}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeUnixTime(locale, node.lastUsedAt)}
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
