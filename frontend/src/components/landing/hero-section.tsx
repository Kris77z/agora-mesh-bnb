'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, Play } from 'lucide-react';
import { motion } from 'motion/react';

/**
 * Hero Section — Claura-style full-screen hero
 * Single-line serif headline + subtitle + dual CTA + floral dot-matrix banner
 */
export function HeroSection() {
    return (
        <section className="min-h-screen flex flex-col items-center justify-center px-8 pt-24 pb-16">
            {/* Badge */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="mb-8"
            >
                <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-border text-xs text-muted-foreground">
                    ✦ Built on BNB · Powered by Altana + x402
                </span>
            </motion.div>

            {/* Main Title — Claura: 70px / -0.07em letter-spacing / 1.1 line-height */}
            <motion.h2
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.1 }}
                className="font-heading text-center leading-[1.1] max-w-5xl"
                style={{
                    fontSize: 'clamp(36px, 5vw, 70px)',
                    letterSpacing: '-0.07em',
                }}
            >
                The Autonomous Agent Economy.
            </motion.h2>

            {/* Subtitle */}
            <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.3 }}
                className="mt-8 text-lg text-muted-foreground max-w-xl text-center leading-relaxed"
            >
                AI Agents discover services, negotiate prices, make payments,
                and verify results on-chain — inside limits set by their users.
            </motion.p>

            {/* CTA Buttons — 8px rounded rectangle, compact padding */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.5 }}
                className="mt-10 flex items-center gap-4"
            >
                <Link
                    href="/onboarding"
                    className="inline-flex items-center gap-2 bg-foreground text-background px-6 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                >
                    Give Hunter a Goal
                    <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                    href="/marketplace"
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium border border-border hover:bg-warm-200/50 transition-colors"
                >
                    Explore Marketplace
                </Link>
                <button className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium border border-border hover:bg-warm-200/50 transition-colors">
                    <Play className="w-3 h-3" />
                    Watch Demo
                </button>
            </motion.div>

            {/* Hero Banner — original Agora Mesh artwork, served locally. */}
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 1, delay: 0.7 }}
                className="mt-16 w-full max-w-4xl"
            >
                <div className="relative aspect-[2/1] overflow-hidden rounded-3xl">
                    <Image
                        src="/landing/hero-floral.png"
                        alt="Agent economy visualization — abstract floral"
                        fill
                        priority
                        sizes="(max-width: 1024px) 100vw, 896px"
                        className="object-cover"
                    />

                    <div
                        className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay"
                        style={{
                            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
                        }}
                    />
                </div>
            </motion.div>
        </section>
    );
}
