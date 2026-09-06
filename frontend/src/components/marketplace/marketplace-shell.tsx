import Link from 'next/link';
import { ArrowUpRight, Bot, Network } from 'lucide-react';
import type { ReactNode } from 'react';

export function MarketplaceShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-foreground text-background">
              <Network className="h-4 w-4" />
            </span>
            <span>
              <span className="block font-heading text-lg font-semibold leading-none">Agora Mesh</span>
              <span className="mt-1 block text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Agent economy on BNB</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <Link href="/marketplace" className="text-foreground">Marketplace</Link>
            <Link href="/compare" className="transition-colors hover:text-foreground">Compare</Link>
            <Link href="/authority" className="transition-colors hover:text-foreground">Authority</Link>
            <Link href="/advantage" className="transition-colors hover:text-foreground">Advantage</Link>
            <Link href="/dashboard" className="transition-colors hover:text-foreground">Live trace</Link>
          </nav>
          <Link
            href="/authority/manage"
            className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
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
