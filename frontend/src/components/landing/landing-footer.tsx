import Link from 'next/link';

/**
 * Landing Footer — Minimal footer with four-column link grid
 * Decorative gradient divider + copyright bar
 */

const COLUMNS = [
    {
        title: 'Navigate',
        links: [
            { label: 'Home', href: '/' },
            { label: 'Get Started', href: '/onboarding' },
            { label: 'Vision', href: '#vision' },
            { label: 'How It Works', href: '#process' },
        ],
    },
    {
        title: 'Resources',
        links: [
            { label: 'Architecture', href: '#tech' },
            { label: 'x402 Protocol', href: 'https://www.x402.org/' },
            { label: 'ERC-8004', href: '#' },
            { label: 'Documentation', href: '#' },
        ],
    },
    {
        title: 'Ecosystem',
        links: [
            { label: 'BNB Chain', href: 'https://www.bnbchain.org/' },
            { label: 'BscScan Testnet', href: 'https://testnet.bscscan.com' },
            { label: 'Altana', href: 'https://docs.altana.network/' },
        ],
    },
    {
        title: 'Connect',
        links: [
            { label: 'Twitter', href: '#' },
            { label: 'GitHub', href: '#' },
            { label: 'Discord', href: '#' },
        ],
    },
];

export function LandingFooter() {
    return (
        <footer className="border-t border-border">
            {/* Link grid */}
            <div className="max-w-6xl mx-auto px-8 pt-12 pb-12">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                    {COLUMNS.map((col) => (
                        <div key={col.title}>
                            <h4 className="text-sm font-semibold text-foreground mb-4">
                                {col.title}
                            </h4>
                            <ul className="space-y-3">
                                {col.links.map((link) => (
                                    <li key={link.label}>
                                        <Link
                                            href={link.href}
                                            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {link.label}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>

            {/* Bottom bar */}
            <div className="border-t border-border">
                <div className="max-w-6xl mx-auto px-8 py-6 flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                        © 2026 Agora Mesh. All rights reserved.
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Built on BNB
                    </p>
                </div>
            </div>
        </footer>
    );
}
