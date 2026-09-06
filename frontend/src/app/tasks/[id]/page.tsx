import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  Check,
  Clock3,
  FileCode2,
  Fingerprint,
  ReceiptText,
  ShieldCheck,
  TriangleAlert,
  WalletCards,
  X,
} from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { publicChainConfig } from '@/lib/chain-config';
import { formatTokenAmount, shortenAddress } from '@/lib/format';
import { getMission } from '@/lib/mission-api';
import type {
  AgentEvent,
  AssetRef,
  ExecutionResult,
  FindingVerification,
  HunterRunResult,
  VerificationReport,
} from '@/types/agent';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Task Evidence | Agora Mesh',
  description: 'Inspect an autonomous Hunter mission, its payments, signed results, and independent verification.',
};

interface AuditFinding {
  findingId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
  evidence?: { file?: string; lines?: string; snippet?: string };
  recommendation?: string;
  confidence?: number;
}

interface AuditReport {
  vulnerabilities: AuditFinding[];
}

interface PaymentView {
  role: string;
  service: HunterRunResult['service'];
  execution: ExecutionResult;
  txHash: string;
  asset: AssetRef;
  amount: string;
}

const fallbackAsset: AssetRef = {
  chainId: 97,
  kind: 'erc20',
  symbol: 'U',
  decimals: 18,
};

function parseAuditReport(raw: string): AuditReport | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<AuditReport>;
    return Array.isArray(parsed.vulnerabilities) ? parsed as AuditReport : undefined;
  } catch {
    return undefined;
  }
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(timestampMs)) + ' UTC';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function taskSummary(goal: string): string {
  return goal.split(/\s+Source:\s*/i)[0]?.trim() || goal;
}

function paymentView(
  role: string,
  service: HunterRunResult['service'],
  execution: ExecutionResult,
  txHash: string,
): PaymentView {
  return {
    role,
    service,
    execution,
    txHash,
    asset: execution.payment.amount?.asset ?? service.asset ?? fallbackAsset,
    amount: execution.payment.amount?.amount ?? service.price,
  };
}

function totalPayments(payments: PaymentView[]): { asset: AssetRef; amount: string } | undefined {
  const first = payments[0];
  if (!first) return undefined;
  const sameAsset = payments.every((payment) =>
    payment.asset.chainId === first.asset.chainId &&
    payment.asset.kind === first.asset.kind &&
    payment.asset.address?.toLowerCase() === first.asset.address?.toLowerCase());
  if (!sameAsset) return undefined;
  return {
    asset: first.asset,
    amount: payments.reduce((sum, payment) => sum + BigInt(payment.amount), BigInt(0)).toString(),
  };
}

function severityStyle(severity: AuditFinding['severity']): string {
  if (severity === 'critical') return 'border-red-700/25 bg-red-700/10 text-red-800';
  if (severity === 'high') return 'border-orange-700/25 bg-orange-700/10 text-orange-800';
  if (severity === 'medium') return 'border-amber-700/25 bg-amber-700/10 text-amber-800';
  return 'border-border bg-secondary text-muted-foreground';
}

function verificationStyle(status: FindingVerification['status']): string {
  if (status === 'confirmed') return 'text-emerald-700';
  if (status === 'rejected') return 'text-destructive';
  if (status === 'partial') return 'text-amber-700';
  if (status === 'missed') return 'text-violet-700';
  return 'text-muted-foreground';
}

function eventLabel(event: AgentEvent): string {
  const labels: Record<string, string> = {
    run_started: 'Goal accepted',
    services_discovered: 'Services discovered',
    service_ranked: 'Candidates ranked',
    service_selected: 'Provider selected',
    security_input_resolved: 'Solidity source bound',
    x402_requirement_received: 'x402 requirement received',
    payment_policy_checked: 'Authority policy passed',
    payment_confirmed: 'Payment confirmed',
    receipt_verified: 'Signed receipt verified',
    verifier_hired: 'Independent verifier hired',
    finding_verified: 'Finding checked',
    evaluation_completed: 'Quality evaluated',
    feedback_submitted: 'Reputation updated',
    run_completed: 'Mission completed',
    run_failed: 'Mission failed',
  };
  return labels[event.type] ?? event.type.replaceAll('_', ' ');
}

function eventDetail(event: AgentEvent): string | undefined {
  if (!event.data || typeof event.data !== 'object') return undefined;
  const data = event.data as Record<string, unknown>;
  if (event.type === 'payment_confirmed') {
    const amount = data.amount && typeof data.amount === 'object'
      ? data.amount as { amount?: unknown; asset?: { symbol?: unknown; decimals?: unknown } }
      : undefined;
    if (typeof amount?.amount === 'string') {
      return `${formatTokenAmount(amount.amount, typeof amount.asset?.decimals === 'number' ? amount.asset.decimals : 18, 3)} ${typeof amount.asset?.symbol === 'string' ? amount.asset.symbol : 'U'}`;
    }
  }
  if (event.type === 'finding_verified') {
    return [data.status, data.detector ?? (data.evidence as { detector?: unknown } | undefined)?.detector]
      .filter((value): value is string => typeof value === 'string')
      .join(' · ');
  }
  if (typeof data.serviceId === 'string') return data.serviceId;
  if (typeof data.score === 'number') return `Score ${data.score}/10`;
  return undefined;
}

function MissionUnavailable({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
      <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-8">
        <h1 className="font-heading text-4xl font-semibold">Task evidence unavailable</h1>
        <p className="mt-4 text-sm text-muted-foreground">{message}</p>
        <Link href="/dashboard" className="mt-6 inline-flex items-center gap-2 text-sm font-medium"><ArrowLeft className="h-4 w-4" /> Back to live trace</Link>
      </div>
    </main>
  );
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let mission;
  try {
    mission = await getMission(decodeURIComponent(id));
  } catch (error) {
    return <MarketplaceShell><MissionUnavailable message={error instanceof Error ? error.message : 'Unknown Mission API error'} /></MarketplaceShell>;
  }

  const result = mission.result;
  if (!result) {
    return <MarketplaceShell><MissionUnavailable message={mission.error?.message ?? 'This task has no completed result artifact.'} /></MarketplaceShell>;
  }
  const audit = parseAuditReport(result.execution.result);
  const verification = result.verification?.report;
  const payments = [
    paymentView('Security audit', result.service, result.execution, result.paymentTx),
    ...(result.verification
      ? [paymentView('Independent verification', result.verification.service, result.verification.execution, result.verification.paymentTx)]
      : []),
  ];
  const total = totalPayments(payments);
  const evidenceEvents = mission.events.filter((event) => event.type !== 'execution_heartbeat');

  return (
    <MarketplaceShell>
      <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-16">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Live trace</Link>
          <Link href="/authority" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ShieldCheck className="h-4 w-4" /> View Authority</Link>
        </div>

        {mission.source === 'recovered-evidence' && (
          <div className="mt-8 flex gap-3 rounded-xl border border-amber-700/20 bg-amber-700/10 p-4 text-sm leading-6 text-amber-900">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>This mission predates server-side task persistence. The page was recovered from confirmed x402 payments, signed delivery receipts, and Hunter memory; only evidence-bearing stages are shown.</p>
          </div>
        )}

        <section className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-700/20 bg-emerald-700/10 px-3 py-1.5 font-mono text-xs font-semibold uppercase text-emerald-800"><Check className="h-3 w-3" /> {mission.status}</span>
              <span className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">{mission.mode}</span>
            </div>
            <h1 className="mt-5 max-w-4xl font-heading text-5xl font-semibold tracking-[-0.045em] sm:text-6xl">Verified task evidence</h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">{taskSummary(mission.goal)}</p>
            <details className="mt-5 rounded-xl border border-border bg-card p-4 text-sm">
              <summary className="cursor-pointer font-medium">Inspect complete goal and source</summary>
              <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">{mission.goal}</pre>
            </details>
          </div>

          <aside className="h-fit rounded-2xl border border-border bg-card p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Mission facts</p>
            <dl className="mt-5 space-y-4 text-sm">
              <div><dt className="text-xs text-muted-foreground">Mission ID</dt><dd className="mt-1 break-all font-mono text-xs">{mission.missionId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Evidence window</dt><dd className="mt-1 font-mono">{formatDuration(mission.completedAt - mission.createdAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Completed</dt><dd className="mt-1">{formatTimestamp(mission.completedAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Quality score</dt><dd className="mt-1 font-mono text-2xl font-semibold">{result.evaluation.score}<span className="text-sm text-muted-foreground">/10</span></dd></div>
              {total && <div><dt className="text-xs text-muted-foreground">Total autonomous spend</dt><dd className="mt-1 font-mono text-2xl font-semibold">{formatTokenAmount(total.amount, total.asset.decimals, 3)} <span className="text-sm text-muted-foreground">{total.asset.symbol}</span></dd></div>}
            </dl>
          </aside>
        </section>

        <section className="mt-10 grid gap-5 md:grid-cols-3">
          <article className="rounded-2xl border border-border bg-card p-5"><WalletCards className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Hunter</p><p className="mt-1 font-medium">Autonomous buyer</p><p className="mt-2 font-mono text-xs text-muted-foreground">Chain {mission.chainId}</p></article>
          <article className="rounded-2xl border border-border bg-card p-5"><FileCode2 className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Primary provider</p><p className="mt-1 font-medium">{result.service.name}</p><p className="mt-2 font-mono text-xs text-muted-foreground">{result.service.id}</p></article>
          <article className="rounded-2xl border border-border bg-card p-5"><BadgeCheck className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Independent check</p><p className="mt-1 font-medium">{result.verification?.service.name ?? 'Not requested'}</p><p className="mt-2 font-mono text-xs text-muted-foreground">{verification ? `${verification.engine.name}@${verification.engine.version ?? 'unknown'}` : '—'}</p></article>
        </section>

        <section className="mt-10 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <article className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Execution trace</p><h2 className="mt-2 font-heading text-3xl font-semibold">Evidence timeline</h2></div><Clock3 className="h-5 w-5 text-muted-foreground" /></div>
            <ol className="mt-6 space-y-0">
              {evidenceEvents.map((event, index) => (
                <li key={`${event.at}-${event.type}-${index}`} className="relative grid grid-cols-[20px_1fr] gap-3 pb-5 last:pb-0">
                  {index < evidenceEvents.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-border" />}
                  <span className={`relative mt-1.5 h-3 w-3 rounded-full border-2 border-card ${event.type === 'run_failed' ? 'bg-destructive' : event.type === 'run_completed' ? 'bg-emerald-700' : 'bg-foreground'}`} />
                  <div><p className="text-sm font-medium">{eventLabel(event)}</p>{eventDetail(event) && <p className="mt-1 text-xs text-muted-foreground">{eventDetail(event)}</p>}<p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatTimestamp(Date.parse(event.at))}</p></div>
                </li>
              ))}
            </ol>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Payment evidence</p><h2 className="mt-2 font-heading text-3xl font-semibold">Confirmed x402 settlement</h2></div><ReceiptText className="h-5 w-5 text-muted-foreground" /></div>
            <div className="mt-6 divide-y divide-border rounded-xl border border-border">
              {payments.map((payment) => (
                <div key={payment.txHash} className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div><p className="text-sm font-medium">{payment.role} · {payment.service.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{shortenAddress(payment.execution.payment.recipient ?? payment.service.provider ?? '', 6)}</p></div>
                  <div className="sm:text-right"><p className="font-mono text-sm font-semibold">{formatTokenAmount(payment.amount, payment.asset.decimals, 3)} {payment.asset.symbol}</p><a href={`${publicChainConfig.explorerUrl}/tx/${payment.txHash}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">View on BscScan <ArrowUpRight className="h-3 w-3" /></a></div>
                </div>
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-secondary/60 p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Fingerprint className="h-3.5 w-3.5" /> Auditor request hash</p><p className="mt-2 break-all font-mono text-[11px]">{result.execution.receipt.requestHash}</p></div>
              <div className="rounded-xl bg-secondary/60 p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Fingerprint className="h-3.5 w-3.5" /> Verifier request hash</p><p className="mt-2 break-all font-mono text-[11px]">{result.verification?.execution.receipt.requestHash ?? '—'}</p></div>
            </div>
          </article>
        </section>

        <section className="mt-10">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Audit result</p><h2 className="mt-2 font-heading text-4xl font-semibold">Auditor findings</h2><p className="mt-3 break-words text-sm text-muted-foreground">Signed result hash: <span className="break-all font-mono">{result.execution.receipt.resultHash}</span></p></div>
          <div className="mt-6 grid min-w-0 gap-5 lg:grid-cols-2">
            {(audit?.vulnerabilities ?? []).map((finding) => (
              <article key={finding.findingId} className="min-w-0 rounded-2xl border border-border bg-card p-6">
                <div className="flex flex-wrap items-center justify-between gap-3"><span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase ${severityStyle(finding.severity)}`}>{finding.severity}</span>{typeof finding.confidence === 'number' && <span className="font-mono text-xs text-muted-foreground">{Math.round(finding.confidence * 100)}% confidence</span>}</div>
                <h3 className="mt-4 font-heading text-2xl font-semibold">{finding.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{finding.description}</p>
                {finding.evidence?.snippet && <pre className="mt-4 max-w-full overflow-auto rounded-lg bg-foreground p-4 font-mono text-xs leading-5 text-background">{finding.evidence.lines ? `${finding.evidence.file ?? 'Contract.sol'}:${finding.evidence.lines}\n` : ''}{finding.evidence.snippet}</pre>}
                {finding.recommendation && <p className="mt-4 border-t border-border pt-4 text-sm leading-6"><span className="font-medium">Fix:</span> {finding.recommendation}</p>}
              </article>
            ))}
          </div>
          {!audit && <pre className="mt-6 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl border border-border bg-card p-6 font-mono text-xs leading-5">{result.execution.result}</pre>}
        </section>

        {verification && <VerificationSection report={verification} />}
      </main>
    </MarketplaceShell>
  );
}

function VerificationSection({ report }: { report: VerificationReport }) {
  const summary = report.summary;
  return (
    <section className="mt-10 rounded-3xl border border-border bg-card p-6 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Independent verification</p><h2 className="mt-2 font-heading text-4xl font-semibold">Static evidence, not self-agreement</h2><p className="mt-3 text-sm text-muted-foreground">{report.engine.name}@{report.engine.version ?? 'unknown'} · source {shortenAddress(report.sourceHash, 10)}</p></div>
        <div className="flex flex-wrap gap-2 font-mono text-xs">{Object.entries(summary).map(([label, count]) => <span key={label} className="rounded-full border border-border px-3 py-1.5">{label} {count}</span>)}</div>
      </div>
      <div className="mt-7 divide-y divide-border rounded-xl border border-border">
        {report.verifications.map((item) => (
          <div key={item.findingId} className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_110px]">
            <div><p className="font-mono text-xs font-semibold">{item.findingId}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{item.evidence.note}</p>{item.evidence.snippet && <code className="mt-2 block break-words text-xs">{item.evidence.lines ? `${item.evidence.lines} · ` : ''}{item.evidence.snippet}</code>}</div>
            <div className="sm:text-right"><p className={`inline-flex items-center gap-1 font-mono text-xs font-semibold uppercase ${verificationStyle(item.status)}`}>{item.status === 'rejected' ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}{item.status}</p><p className="mt-2 text-xs text-muted-foreground">{item.method}<br />{Math.round(item.confidence * 100)}% confidence</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
