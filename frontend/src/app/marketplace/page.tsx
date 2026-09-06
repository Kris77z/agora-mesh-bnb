'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, Search, Sparkles } from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { ServiceCard } from '@/components/marketplace/service-card';
import { listMarketplaceServices } from '@/lib/marketplace-api';

const categories = [
  { label: 'All services', value: '' },
  { label: 'Security', value: 'solidity' },
  { label: 'Verification', value: 'finding-verification' },
  { label: 'Investigation', value: 'onchain-investigation' },
  { label: 'Analysis', value: 'defi-analysis' },
];

export default function MarketplacePage() {
  const [category, setCategory] = useState('');
  const { data, error, isLoading } = useSWR(['marketplace-services', category], () => listMarketplaceServices(category));
  const services = data?.services ?? [];

  return (
    <MarketplaceShell>
      <main>
        <section className="border-b border-border">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1.25fr_0.75fr] lg:py-24">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3" /> Transparent autonomous procurement
              </div>
              <h1 className="mt-6 max-w-3xl font-heading text-5xl font-semibold leading-[0.95] tracking-[-0.05em] sm:text-7xl">
                See what Hunter sees.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                This marketplace is the decision surface behind autonomous hiring: capabilities, price, reputation, latency, payment rail, and the evidence used to choose.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/authority/manage" className="inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background">
                  Give Hunter a goal <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href="/compare" className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium hover:bg-secondary">
                  Open comparison
                </Link>
              </div>
            </div>
            <div className="rounded-3xl border border-border bg-card p-6 lg:self-end">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Hunter decision loop</p>
              <ol className="mt-5 space-y-4 text-sm">
                {['Discover eligible providers', 'Rank the same catalog shown here', 'Validate quote, budget, and authority', 'Pay, execute, and hire an independent verifier'].map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span className="font-mono text-muted-foreground">0{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Service catalog</p>
              <h2 className="mt-2 font-heading text-3xl font-semibold">Discoverable agents</h2>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Filter service categories">
              {categories.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setCategory(item.value)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${category === item.value ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {isLoading && <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">Reading the Registry…</div>}
          {error && (
            <div className="mt-8 rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-sm text-destructive">
              Registry unavailable: {error instanceof Error ? error.message : 'unknown error'}. Start the local agents to load the live catalog.
            </div>
          )}
          {!isLoading && !error && services.length === 0 && (
            <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
              <Search className="mx-auto mb-3 h-5 w-5" /> No services match this category.
            </div>
          )}
          <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {services.map((service) => <ServiceCard key={service.id} service={service} />)}
          </div>
        </section>
      </main>
    </MarketplaceShell>
  );
}
