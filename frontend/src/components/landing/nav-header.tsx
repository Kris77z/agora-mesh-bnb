'use client';

import Link from 'next/link';

/**
 * Minimal navigation bar — Claura style
 * Left: anchor links | Center: brand logo (serif) | Right: CTA button
 */
export function NavHeader() {
    const scrollTo = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md">
            <nav className="max-w-7xl mx-auto px-8 py-5 flex items-center justify-between">
                {/* Left: Nav Links */}
                <div className="flex items-center gap-8">
                    <Link
                        href="/marketplace"
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Marketplace
                    </Link>
                    <Link
                        href="/authority"
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Authority
                    </Link>
                    <Link
                        href="/advantage"
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Advantage
                    </Link>
                    <button
                        onClick={() => scrollTo('vision')}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Vision
                    </button>
                    <button
                        onClick={() => scrollTo('process')}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        How It Works
                    </button>
                    <button
                        onClick={() => scrollTo('tech')}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Tech Stack
                    </button>
                </div>

                {/* Center: Brand */}
                <Link href="/" className="absolute left-1/2 -translate-x-1/2">
                    <h1 className="text-2xl font-heading font-semibold text-foreground tracking-tight">
                        Agora Mesh
                    </h1>
                </Link>

                {/* Right: CTA */}
                <Link
                    href="/dashboard"
                    className="bg-foreground text-background px-5 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                >
                    Give Hunter a Goal
                </Link>
            </nav>
        </header>
    );
}
