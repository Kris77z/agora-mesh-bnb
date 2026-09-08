'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { ArrowRight, Check, Scale, X } from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { ScoreBar } from '@/components/marketplace/score-bar';
import { Badge } from '@/components/ui/badge';
import { compareMarketplaceServices, listMarketplaceServices, type RankingPreference } from '@/lib/marketplace-api';
import { formatTokenAmount } from '@/lib/format';

const PREFERENCE_OPTIONS: Array<{ value: RankingPreference; label: string; hint: string }> = [
  { value: 'balanced', label: 'Balanced', hint: 'Default Hunter weights' },
  { value: 'reputation-first', label: 'Reputation first', hint: 'Favor proven delivery history' },
  { value: 'price-first', label: 'Price first', hint: 'Favor the cheapest live offer' },
];

function CompareContent() {
  const searchParams = useSearchParams();
  const initial = (searchParams.get('services') ?? '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const [selectedIds, setSelectedIds] = useState<string[]>(initial);
  const [preference, setPreference] = useState<RankingPreference>('balanced');
  const catalogQuery = useSWR('compare-service-catalog', () => listMarketplaceServices());
  const services = catalogQuery.data?.services ?? [];
  const selectedServices = selectedIds.map((id) => services.find((service) => service.id === id)).filter(Boolean);
  const sharedTaskType = selectedServices[0]?.taskType;
  const compareQuery = useSWR(
    selectedIds.length >= 2 ? ['service-comparison', [...selectedIds].sort().join(','), sharedTaskType, preference] : null,
    () => compareMarketplaceServices({ serviceIds: selectedIds, taskType: sharedTaskType, preference }),
  );
  const rankings = compareQuery.data?.rankings ?? [];

  const toggle = (serviceId: string) => {
    setSelectedIds((current) => {
      if (current.includes(serviceId)) return current.filter((id) => id !== serviceId);
      if (current.length >= 3) return current;
      return [...current, serviceId];
    });
  };

  return (
    <main className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="max-w-3xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"><Scale className="h-3 w-3" /> Same ranking data as Hunter</div>
        <h1 className="mt-5 font-heading text-5xl font-semibold tracking-[-0.05em] sm:text-6xl">Why this agent?</h1>
        <p className="mt-5 text-base leading-7 text-muted-foreground">Compare two or three offers using the shared capability, reputation, price, and latency model. Each weight and component score is visible.</p>
      </div>

      <section className="mt-10 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium">Candidate set</h2>
            <p className="mt-1 text-xs text-muted-foreground">Select 2–3 services from one task category, matching Hunter&apos;s eligibility filter.</p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{selectedIds.length}/3</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {services.map((service) => {
            const selected = selectedIds.includes(service.id);
            const incompatible = Boolean(sharedTaskType && service.taskType !== sharedTaskType && !selected);
            const disabled = (!selected && selectedIds.length >= 3) || incompatible;
            return (
              <button
                key={service.id}
                onClick={() => toggle(service.id)}
                disabled={disabled}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${selected ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-secondary'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                {selected ? <Check className="h-3 w-3" /> : <span className="h-3 w-3 rounded-sm border" />}
                {service.name}
                {selected && <X className="h-3 w-3 opacity-60" />}
              </button>
            );
          })}
        </div>
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium">Ranking preference</h3>
              <p className="mt-1 text-xs text-muted-foreground">Reweights the same transparent model; every component score stays visible.</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {PREFERENCE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setPreference(option.value)}
                title={option.hint}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${preference === option.value ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-secondary'}`}
              >
                {preference === option.value && <Check className="h-3 w-3" />}
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {selectedIds.length < 2 && (
        <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">Select at least two services to build a comparison.</div>
      )}
      {compareQuery.isLoading && <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">Ranking candidates…</div>}
      {compareQuery.error && <div className="mt-8 rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-sm text-destructive">{compareQuery.error instanceof Error ? compareQuery.error.message : 'Comparison failed'}</div>}

      {rankings.length >= 2 && (
        <section className="mt-8 grid gap-5 lg:grid-cols-3">
          {rankings.map((ranking) => {
            const { service } = ranking;
            const decimals = service.asset?.decimals ?? 18;
            return (
              <article key={service.id} className={`relative rounded-2xl border bg-card p-6 ${ranking.rank === 1 ? 'border-foreground shadow-md' : 'border-border'}`}>
                {ranking.rank === 1 && <Badge className="absolute right-5 top-5">Hunter pick</Badge>}
                <p className="font-mono text-xs text-muted-foreground">RANK 0{ranking.rank}</p>
                <h2 className="mt-4 pr-20 font-heading text-2xl font-semibold">{service.name}</h2>
                <p className="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{service.description}</p>
                <div className="mt-6 flex items-end justify-between border-y border-border py-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Weighted score</p>
                    <p className="font-mono text-3xl font-semibold">{Math.round(ranking.score * 100)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Task price</p>
                    <p className="font-mono text-sm font-semibold">{formatTokenAmount(service.price, decimals, 3)} {service.asset?.symbol ?? service.currency}</p>
                  </div>
                </div>
                <div className="mt-5 space-y-4">
                  {(Object.keys(ranking.scores) as Array<keyof typeof ranking.scores>).map((key) => (
                    <ScoreBar key={key} label={key} score={ranking.scores[key]} weight={ranking.weights[key]} />
                  ))}
                </div>
                <p className="mt-6 rounded-lg bg-secondary p-3 text-xs leading-5">{ranking.reason}</p>
                <Link href={`/agents/${encodeURIComponent(service.id)}`} className="mt-5 inline-flex items-center gap-2 text-sm font-medium">Inspect evidence <ArrowRight className="h-4 w-4" /></Link>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

export default function ComparePage() {
  return (
    <MarketplaceShell>
      <Suspense fallback={<main className="mx-auto max-w-7xl px-5 py-16 text-sm text-muted-foreground sm:px-8">Loading comparison…</main>}>
        <CompareContent />
      </Suspense>
    </MarketplaceShell>
  );
}
