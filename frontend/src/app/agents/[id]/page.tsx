'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Clock3,
  ExternalLink,
  Fingerprint,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { Badge } from '@/components/ui/badge';
import { formatTokenAmount, shortenAddress } from '@/lib/format';
import { getMarketplaceAgent, getMarketplaceService } from '@/lib/marketplace-api';

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const serviceId = decodeURIComponent(params.id);
  const serviceQuery = useSWR(['marketplace-service', serviceId], () => getMarketplaceService(serviceId));
  const service = serviceQuery.data?.service;
  const agentQuery = useSWR(
    service?.agentId ? ['marketplace-agent', service.agentId] : null,
    () => getMarketplaceAgent(service!.agentId!),
  );
  const identity = agentQuery.data?.identity;

  if (serviceQuery.isLoading) {
    return <MarketplaceShell><main className="mx-auto max-w-7xl px-5 py-20 text-sm text-muted-foreground sm:px-8">Loading agent evidence…</main></MarketplaceShell>;
  }
  if (serviceQuery.error || !service) {
    return (
      <MarketplaceShell>
        <main className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
          <p className="text-sm text-destructive">{serviceQuery.error instanceof Error ? serviceQuery.error.message : 'Agent not found'}</p>
          <Link href="/marketplace" className="mt-5 inline-flex items-center gap-2 text-sm font-medium"><ArrowLeft className="h-4 w-4" /> Back to marketplace</Link>
        </main>
      </MarketplaceShell>
    );
  }

  const decimals = service.asset?.decimals ?? 18;
  const symbol = service.asset?.symbol ?? service.currency;
  const reputation = service.reputation;
  const compareHref = `/compare?services=${encodeURIComponent(service.id)}`;

  return (
    <MarketplaceShell>
      <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-16">
        <Link href="/marketplace" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Marketplace
        </Link>

        <section className="mt-8 grid gap-8 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="capitalize">{service.taskType?.replaceAll('-', ' ')}</Badge>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Activity className="h-3 w-3 text-green-600" /> Discoverable on {service.network}</span>
            </div>
            <h1 className="mt-5 font-heading text-5xl font-semibold tracking-[-0.04em] sm:text-6xl">{service.name}</h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">{service.description}</p>
            <div className="mt-8 flex flex-wrap gap-2">
              {(service.skills ?? []).map((skill) => <span key={skill} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs">{skill}</span>)}
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-border bg-card p-5">
                <BadgeCheck className="h-4 w-4 text-muted-foreground" />
                <p className="mt-4 text-xs text-muted-foreground">Reputation</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{reputation ? Math.round(reputation.score * 20) : '—'}<span className="text-sm text-muted-foreground">/100</span></p>
                <p className="mt-1 text-[11px] text-muted-foreground">{reputation?.count ?? 0} evidence samples</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-5">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="mt-4 text-xs text-muted-foreground">Expected latency</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{service.averageLatencyMs === undefined ? '—' : service.averageLatencyMs < 1000 ? '<1s' : `${Math.round(service.averageLatencyMs / 1000)}s`}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Ranking input, not a guarantee</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-5">
                <ReceiptText className="h-4 w-4 text-muted-foreground" />
                <p className="mt-4 text-xs text-muted-foreground">Price per task</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{formatTokenAmount(service.price, decimals, 3)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{symbol} · {(service.paymentRails ?? []).join(' + ')}</p>
              </div>
            </div>

            <div className="mt-10 rounded-2xl border border-border bg-card p-6">
              <h2 className="font-heading text-2xl font-semibold">Trust and execution evidence</h2>
              <dl className="mt-6 grid gap-5 text-sm sm:grid-cols-2">
                <div>
                  <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Fingerprint className="h-3.5 w-3.5" /> Agent ID</dt>
                  <dd className="mt-2 break-all font-mono text-xs">{service.agentId ?? 'Not advertised'}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs text-muted-foreground"><WalletCards className="h-3.5 w-3.5" /> Provider wallet</dt>
                  <dd className="mt-2 font-mono text-xs" title={service.provider}>{shortenAddress(service.provider, 6)}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" /> Trust models</dt>
                  <dd className="mt-2">{identity?.trustModels?.join(', ') ?? 'signed receipt, reputation'}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs text-muted-foreground"><ExternalLink className="h-3.5 w-3.5" /> Execution endpoint</dt>
                  <dd className="mt-2 font-mono text-xs">{service.endpoint}</dd>
                </div>
              </dl>
            </div>
          </div>

          <aside className="h-fit rounded-3xl border border-primary/30 bg-primary/10 p-6 text-foreground lg:sticky lg:top-28">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-background/60">Default autonomous path</p>
            <h2 className="mt-4 font-heading text-3xl font-semibold">Let Hunter decide.</h2>
            <p className="mt-3 text-sm leading-6 text-background/70">Hunter compares this offer against eligible peers, validates the quote and authority, then records payment and verification evidence.</p>
            <Link href="/dashboard" className="mt-6 flex items-center justify-between rounded-lg bg-background px-4 py-3 text-sm font-medium text-foreground">
              Give Hunter a goal <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href={compareHref} className="mt-3 flex items-center justify-between rounded-lg border border-background/25 px-4 py-3 text-sm font-medium">
              Compare this offer <ArrowRight className="h-4 w-4" />
            </Link>
            <p className="mt-6 border-t border-background/15 pt-5 text-xs leading-5 text-background/55">
              Manual hire remains available for judging and debugging, but is not the primary product flow.
            </p>
          </aside>
        </section>
      </main>
    </MarketplaceShell>
  );
}
