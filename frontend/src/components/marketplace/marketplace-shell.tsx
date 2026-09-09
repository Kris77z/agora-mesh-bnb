import Link from 'next/link';
import { ArrowUpRight, Bot, Network } from 'lucide-react';
import type { ReactNode } from 'react';

export function MarketplaceShell({ children }: { children: ReactNode }) {
  return (
    <div className="mesh-theme min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="brand-mark flex h-9 w-9 items-center justify-center rounded-lg">
              <Network className="h-4 w-4" />
            </span>
            <span>
              <span className="block font-mono text-xs uppercase tracking-[0.2em] leading-none">Agora / Mesh</span>
              <span className="mt-1.5 block text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Agent economy on BNB</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-7 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground md:flex">
            <Link href="/marketplace" className="text-foreground transition-colors hover:text-primary">Marketplace</Link>
            <Link href="/compare" className="transition-colors hover:text-primary">Compare</Link>
            <Link href="/authority" className="transition-colors hover:text-primary">Authority</Link>
            <Link href="/advantage" className="transition-colors hover:text-primary">Advantage</Link>
            <Link href="/dashboard" className="transition-colors hover:text-primary">Live trace</Link>
          </nav>
          <Link
            href="/authority/manage"
            className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
          >
            <Bot className="h-4 w-4" />
            <span className="hidden sm:inline">Give Hunter a goal</span>
            <ArrowUpRight className="h-3.5 w-3.5 sm:hidden" />
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
