'use client';

import { useState, useEffect, useRef } from 'react';
import { GoalInput } from '@/components/agent/goal-input';
import { useI18n } from '@/components/i18n/locale-provider';
import { LocaleSwitcher } from '@/components/i18n/locale-switcher';
import { ChainStatusBar } from '@/components/layout/chain-status-bar';
import { AgentMeshPanel } from '@/components/panels/agent-mesh-panel';
import { MyAgentPanel, type MyAgentStatus } from '@/components/panels/my-agent-panel';
import { MissionTimeline } from '@/components/timeline/mission-timeline';
import { MissionHistoryDrawer } from '@/components/history/mission-history-drawer';
import { useAgentIdentity } from '@/hooks/use-agent-identity';
import { useBrowserAuthority } from '@/hooks/use-browser-authority';
import { AuthorityControls } from '@/components/authority/authority-controls';
import { boundedRunView } from '@/lib/bounded-run-view';
import { useMissionHistory } from '@/hooks/use-mission-history';
import type { AgentEvent } from '@/types/agent';
import { asRecord } from '@/lib/type-guards';
import { AlertCircle, History } from 'lucide-react';
import Link from 'next/link';
import { formatTokenAmount } from '@/lib/format';

/* ─── Helpers ─── */

function deriveAgentStatus(status: string, events: AgentEvent[]): MyAgentStatus {
  if (status === 'IDLE') return 'idle';
  if (status === 'ERROR') return 'error';
  if (status === 'COMPLETED') return 'completed';
  const last = [...events].reverse().find((e) =>
    ['payment_state', 'receipt_verified', 'evaluation_completed'].includes(e.type)
  );
  if (last?.type === 'payment_state') return 'paying';
  if (last?.type === 'receipt_verified' || last?.type === 'evaluation_completed') return 'verifying';
  if (status === 'RUNNING') return 'thinking';
  return 'idle';
}

function extractMission(events: AgentEvent[]): string | undefined {
  const run = events.find((e) => e.type === 'run_started');
  if (!run?.data || typeof run.data !== 'object') return undefined;
  const goal = (run.data as Record<string, unknown>).goal;
  return typeof goal === 'string' ? goal : undefined;
}

/* asRecord imported from @/lib/type-guards */

/* ─── Mobile tab constants ─── */
const TABS = [
  { key: 'agent', labelKey: 'dashboard.tab.agent' },
  { key: 'mission', labelKey: 'dashboard.tab.mission' },
  { key: 'mesh', labelKey: 'dashboard.tab.mesh' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/* ─── Page ─── */

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const authority = useBrowserAuthority();
  const { status, events, result, error: runError } = boundedRunView(authority.run);
  const error = authority.error || runError;
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionsDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('panel') === 'authority') setPermissionsOpen(true); }, []);
  useEffect(() => { const dialog=permissionsDialog.current; if (permissionsOpen && dialog && !dialog.open) dialog.showModal(); else if (!permissionsOpen && dialog?.open) dialog.close(); }, [permissionsOpen]);
  const startRun = (goal: string, mode: 'single' | 'commander' = 'single', language: 'en-US' | 'zh-CN' = locale) => {
    if (!authority.active) { setInjectedGoal(goal); setPermissionsOpen(true); return false; }
    void authority.startRun(goal, mode, language); return true;
  };
  const { hunter, loading: idLoading, hunterError, refresh } = useAgentIdentity();

  const { history, addRecord, clearHistory } = useMissionHistory();
  const agentStatus = deriveAgentStatus(status, events);
  const currentMission = extractMission(events);
  const [activeTab, setActiveTab] = useState<TabKey>('mission');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [injectedGoal, setInjectedGoal] = useState<string | undefined>();
  useEffect(() => { if (authority.access?.requestGoal && !authority.access.missionId) setInjectedGoal(authority.access.requestGoal); }, [authority.access]);

  // Track which run we've already saved to history
  const savedRunRef = useRef<string | null>(null);


  // Auto-save completed/failed missions to history
  useEffect(() => {
    if (status !== 'COMPLETED' && status !== 'ERROR') return;
    const goal = extractMission(events);
    if (!goal) return;

    // Generate a unique key for this run to avoid double-saving
    const runKey = `${goal}-${events.length}`;
    if (savedRunRef.current === runKey) return;
    savedRunRef.current = runKey;

    // Extract metadata from events
    const quote = [...events].reverse().find((e) => e.type === 'quote_received');
    const spentAmount = typeof asRecord(quote?.data)?.amount === 'string'
      ? (asRecord(quote?.data)?.amount as string) : undefined;
    const evalEv = [...events].reverse().find((e) => e.type === 'evaluation_completed');
    const score = typeof asRecord(evalEv?.data)?.score === 'number'
      ? (asRecord(evalEv?.data)?.score as number) : undefined;
    const selected = [...events].reverse().find((e) => e.type === 'service_selected');
    const serviceName = typeof asRecord(selected?.data)?.id === 'string'
      ? (asRecord(selected?.data)?.id as string) : undefined;

    // Calculate duration
    const started = events.find((e) => e.type === 'run_started');
    const ended = [...events].reverse().find((e) => e.type === 'run_completed' || e.type === 'run_failed');
    let duration: number | undefined;
    if (started && ended) {
      const s = new Date(started.at).getTime();
      const e = new Date(ended.at).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        duration = Math.round((e - s) / 1000);
      }
    }

    addRecord({
      goal,
      status: status === 'COMPLETED' ? 'completed' : 'error',
      spentAmount,
      assetSymbol: 'U',
      assetDecimals: 18,
      score,
      serviceName,
      duration,
    });
  }, [status, events, addRecord]);

  return (
    <div className="h-screen flex flex-col">
      <dialog ref={permissionsDialog} onClose={() => setPermissionsOpen(false)} aria-label={locale === 'zh-CN' ? '钱包与权限' : 'Wallet and permissions'} className="m-auto max-h-[90dvh] w-[min(44rem,95vw)] overflow-y-auto border border-border bg-background p-0 text-foreground backdrop:bg-black/60">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-3 font-mono text-sm"><span>{locale === 'zh-CN' ? '钱包 · 预算 · 撤权' : 'Wallet · Budget · Revoke'}</span><button onClick={() => setPermissionsOpen(false)} aria-label={locale === 'zh-CN' ? '关闭权限面板' : 'Close permissions'} className="px-3 py-1">✕</button></div>
        <AuthorityControls controller={authority} />
      </dialog>
      {/* ═══ History Drawer ═══ */}
      <MissionHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={history}
        onClear={clearHistory}
        onSelect={(goal) => setInjectedGoal(goal)}
      />


      {/* ═══ Terminal Title Bar ═══ */}
      <header className="border-b border-border bg-card px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            </div>
            <Link href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              <span className="text-primary">agora</span>
              <span className="text-muted-foreground/50">@</span>
              <span>agora-mesh</span>
              <span className="text-muted-foreground/50">:</span>
              <span className="text-primary">~</span>
              <span className="text-muted-foreground/50">$</span>
            </Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <button onClick={() => setPermissionsOpen(true)} className="border border-primary/40 px-2 py-1 text-primary" data-testid="wallet-permissions">{locale === 'zh-CN' ? '钱包 / 预算' : 'Wallet / Budget'}{authority.active ? ' ✓' : ''}</button>
            {/* History button */}
            <button
              onClick={() => setHistoryOpen(true)}
              className="flex items-center gap-1 hover:text-primary hover:text-glow transition-colors cursor-pointer"
              title={t('dashboard.historyTooltip')}
            >
              <History className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('dashboard.history')}</span>
              {history.length > 0 && (
                <span className="text-[9px] text-primary">{history.length}</span>
              )}
            </button>
            <span className="text-border">│</span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="hidden sm:inline">{t('dashboard.network')}</span>
            </span>
            <span className="text-border">│</span>
            <LocaleSwitcher />
            <span className="text-primary text-glow">{t(`dashboard.status.${status}`)}</span>
          </div>
        </div>
      </header>

      {/* ═══ Mobile Tab Bar ═══ */}
      <div className="md:hidden border-b border-border bg-card flex">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 text-[11px] transition-colors cursor-pointer ${activeTab === tab.key
              ? 'text-primary border-b-2 border-primary text-glow'
              : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 font-mono text-[11px]">
        <span>{authority.wallet ? `${authority.wallet.address.slice(0,6)}…${authority.wallet.address.slice(-4)}` : (locale === 'zh-CN' ? '尚未连接 Passkey 钱包' : 'Passkey wallet not connected')}</span>
        <span>{authority.active ? (locale === 'zh-CN' ? '预算授权已生效' : 'Budget authorized') : (locale === 'zh-CN' ? '开始任务前设置预算授权' : 'Set a wallet budget before starting')}</span>
        {authority.snapshot?.spending?.[0] && <span>{locale === 'zh-CN' ? '已花费' : 'Spent'} {formatTokenAmount(authority.snapshot.spending[0].spent, 18, 3)} U</span>}
        {authority.run?.missionId && <Link className="underline" href={`/tasks/${authority.run.missionId}`}>{locale === 'zh-CN' ? '任务凭证' : 'Task evidence'}</Link>}
      </div>
      {/* ═══ Error Banner ═══ */}
      {error && (
        <div className="mx-4 mt-2 bg-destructive/10 text-destructive p-2.5 flex items-center gap-2 border border-destructive/30 text-xs">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ═══ Desktop: Three-Column / Mobile: Tab Content ═══ */}
      <main className="flex-1 min-h-0 px-4 py-3">
        <div className="hidden md:grid grid-cols-12 gap-4 h-full">
          <aside className="col-span-3 h-full min-h-0 overflow-y-auto scrollbar-thin">
            <MyAgentPanel
              status={agentStatus} mission={currentMission} events={events} result={result}
              identity={hunter} identityLoading={idLoading}
              identityError={hunterError} onRetryIdentity={refresh}
              profile={null} profileLoading={false} profileError={null}
            />
          </aside>
          <section className="col-span-6 h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
              <MissionTimeline events={events} result={result} isRunning={status === 'RUNNING'} hasError={status === 'ERROR'} />
            </div>
            {/* ─── Inline Chat Input ─── */}
            <div className="border border-border bg-card p-3 mt-3 shrink-0">
              <GoalInput onRun={startRun} isLoading={status === 'RUNNING'} externalGoal={injectedGoal} />
            </div>
          </section>
          <aside className="col-span-3 h-full min-h-0 overflow-y-auto scrollbar-thin">
            <AgentMeshPanel events={events} result={result} />
          </aside>
        </div>

        <div className="md:hidden h-full overflow-y-auto scrollbar-thin">
          {activeTab === 'agent' && (
            <MyAgentPanel
              status={agentStatus} mission={currentMission} events={events} result={result}
              identity={hunter} identityLoading={idLoading}
              identityError={hunterError} onRetryIdentity={refresh}
              profile={null} profileLoading={false} profileError={null}
            />
          )}
          {activeTab === 'mission' && (
            <MissionTimeline events={events} result={result} isRunning={status === 'RUNNING'} hasError={status === 'ERROR'} />
          )}
          {activeTab === 'mesh' && (
            <AgentMeshPanel events={events} result={result} />
          )}
          {/* ─── Mobile Inline Chat Input ─── */}
          <div className="border border-border bg-card p-3 mt-3">
            <GoalInput onRun={startRun} isLoading={status === 'RUNNING'} externalGoal={injectedGoal} />
          </div>
        </div>
      </main>

      {/* ═══ Chain Status ═══ */}
      <ChainStatusBar />
    </div>
  );
}
