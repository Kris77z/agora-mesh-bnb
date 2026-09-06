import Link from 'next/link';
import { ArrowRight, Clock3, ShieldCheck, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatTokenAmount } from '@/lib/format';
import type { MarketplaceService } from '@/types/marketplace';

function taskLabel(taskType?: string): string {
  return (taskType ?? 'agent-service').replaceAll('-', ' ');
}

export function ServiceCard({ service }: { service: MarketplaceService }) {
  const decimals = service.asset?.decimals ?? 18;
  const symbol = service.asset?.symbol ?? service.currency;
  const reputation = service.reputation;

  return (
    <article className="group flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-warm-500 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <Badge variant="secondary" className="capitalize">{taskLabel(service.taskType)}</Badge>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{service.network}</span>
      </div>
      <div className="mt-5 flex-1">
        <h2 className="font-heading text-2xl font-semibold tracking-tight">{service.name}</h2>
        <p className="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{service.description}</p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {(service.skills ?? []).slice(0, 4).map((skill) => (
            <span key={skill} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">{skill}</span>
          ))}
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-3 gap-3 border-y border-border py-4 text-xs">
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground"><Star className="h-3 w-3" /> Reputation</dt>
          <dd className="mt-1 font-mono text-sm font-semibold">{reputation ? `${Math.round(reputation.score * 20)}` : '—'}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground"><Clock3 className="h-3 w-3" /> Avg time</dt>
          <dd className="mt-1 font-mono text-sm font-semibold">
            {service.averageLatencyMs === undefined ? '—' : service.averageLatencyMs < 1000 ? '<1s' : `${Math.round(service.averageLatencyMs / 1000)}s`}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground"><ShieldCheck className="h-3 w-3" /> From</dt>
          <dd className="mt-1 font-mono text-sm font-semibold">{formatTokenAmount(service.price, decimals, 3)} {symbol}</dd>
        </div>
      </dl>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{(service.paymentRails ?? []).join(' + ') || 'payment rail pending'}</span>
        <Link href={`/agents/${encodeURIComponent(service.id)}`} className="inline-flex items-center gap-1 text-sm font-medium group-hover:gap-2 transition-all">
          Inspect agent <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  );
}
