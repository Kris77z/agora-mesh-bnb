'use client';

import type { AgentEvent, HunterRunResult } from '@/types/agent';
import type { HunterIdentityResponse } from '@/hooks/use-agent-identity';
import type { HunterProfile } from '@/types/hunter-profile';
import { useI18n } from '@/components/i18n/locale-provider';
import { HunterMemoryProfile } from '@/components/panels/hunter-memory-profile';
import { AgentIdentityCard } from './agent-identity-card';
import { CollapsibleSection } from './collapsible-section';
import { StatusOrb } from './status-orb';
import { LiveRunStats } from './live-run-stats';
import { asRecord } from '@/lib/type-guards';
import { useMemo } from 'react';
import { Bot } from 'lucide-react';
import {
  STATUS_DISPLAY,
  readTotalPaymentAmount,
  readElapsedSeconds,
  collectCommanderPhases,
  readCommanderBudget,
  readCommanderStatus,
} from './panel-helpers';

/* Re-export for consumers (e.g. dashboard/page.tsx) */
export type { MyAgentStatus, CommanderBudget } from './panel-helpers';

import type { MyAgentStatus } from './panel-helpers';

interface MyAgentPanelProps {
  status: MyAgentStatus;
  mission?: string;
  events: AgentEvent[];
  result: HunterRunResult | null;
  identity: HunterIdentityResponse | null;
  identityLoading?: boolean;
  identityError?: string | null;
  onRetryIdentity?: () => void;
  profile: HunterProfile | null;
  profileLoading?: boolean;
  profileError?: string | null;
}

/* ─── Component ─── */

export function MyAgentPanel({
  status, mission, events, result,
  identity, identityLoading, identityError, onRetryIdentity,
  profile, profileLoading, profileError,
}: MyAgentPanelProps) {
  const { t } = useI18n();
  const cfg = STATUS_DISPLAY[status];
  const commanderPhases = useMemo(() => collectCommanderPhases(events, result), [events, result]);
  const commanderAwareStatus = useMemo(
    () => readCommanderStatus(commanderPhases, events, cfg, status),
    [commanderPhases, events, cfg, status],
  );
  const spendAmount = readTotalPaymentAmount(events) ?? '0';
  const commanderBudget = useMemo(() => readCommanderBudget(events, result), [events, result]);
  const txCount = events.filter(
    (e) => e.type === 'payment_state' && asRecord(e.data)?.status === 'payment-completed',
  ).length;
  const elapsed = readElapsedSeconds(events);

  const isConnected = !identityLoading && identity;

  return (
    <div className="h-full flex flex-col">
      {/* Header + Status Orb */}
      <div className="px-1 py-2 mb-2 widget-label flex items-center gap-1.5">
        <Bot className="w-3 h-3" />
        <span>agora.agent</span>
        <StatusOrb status={status} size="md" />
      </div>

      {/* Identity: loading / error states only */}
      {!isConnected && (
        <AgentIdentityCard
          identity={identity}
          identityLoading={identityLoading}
          identityError={identityError}
          onRetryIdentity={onRetryIdentity}
        />
      )}

      {/* Connected details card — fills remaining height */}
      {isConnected && (
        <div className="border border-border bg-card p-4 space-y-3 flex-1 overflow-y-auto scrollbar-thin">
          {/* Agent identity (name + wallet + balance) */}
          <AgentIdentityCard identity={identity} />

          <div className="border-t border-border" />

          {/* Memory Profile — collapsible, default OPEN */}
          <CollapsibleSection label={t('panel.memory')} storageKey="panel-memory" defaultOpen>
            <HunterMemoryProfile profile={profile} loading={profileLoading} error={profileError} />
          </CollapsibleSection>

          <div className="border-t border-border" />

          {/* Live run stats — always visible */}
          <LiveRunStats
            status={commanderAwareStatus}
            spendAmount={spendAmount}
            budgetAmount={commanderBudget.maxTotal?.amount}
            budgetSpentAmount={commanderBudget.spent?.amount}
            assetDecimals={commanderBudget.maxTotal?.asset.decimals ?? 18}
            assetSymbol={commanderBudget.maxTotal?.asset.symbol ?? 'tBNB'}
            hasBudget={commanderPhases.length > 0 && !!commanderBudget.maxTotal}
            txCount={txCount}
            elapsed={elapsed}
            mission={mission}
          />

          {/* On-chain identity — collapsible, default closed */}
          {identity.identity.agentId && (
            <>
              <div className="border-t border-border" />
              <CollapsibleSection label={t('panel.onchain')} storageKey="panel-onchain">
                <div className="text-[10px] space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('panel.agentId')}</span>
                    <span className="text-foreground/80 truncate max-w-[140px]">{identity.identity.agentId}</span>
                  </div>
                  {identity.onchain?.registered && (
                    <span className="text-primary text-glow">{t('panel.registered')}</span>
                  )}
                </div>
              </CollapsibleSection>
            </>
          )}
        </div>
      )}

    </div>
  );
}
