'use client';

import { motion } from 'motion/react';

/**
 * Vision Section — "Product for Agents, not Humans"
 * Centered badge + large serif heading + three glassmorphism stat cards
 * Content derived from agent-economy-vision.md
 */

const STATS = [
    {
        value: 'Scoped',
        label: 'Agent Authority',
        detail: 'Allowlist, spend cap, expiry, and revoke are enforced at the wallet layer.',
    },
    {
        value: '100%',
        label: 'Trustless Verification',
        detail: 'Cryptographic signature verification — no intermediary trust required.',
    },
    {
        value: '∞',
        label: 'Agent Autonomy',
        detail: 'A complete closed loop: discover, decide, transact, and verify.',
    },
];

export function VisionSection() {
    return (
        <section id="vision" className="py-32 px-8">
            <div className="max-w-6xl mx-auto">
                {/* Centered badge */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    className="flex justify-center mb-6"
                >
                    <span className="inline-block px-4 py-1.5 rounded-full border border-border text-xs text-muted-foreground">
                        Our Vision
                    </span>
                </motion.div>

                {/* Large serif heading with muted accent */}
                <motion.h2
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.1 }}
                    className="font-heading text-5xl md:text-6xl text-center leading-[1.1] tracking-tight max-w-3xl mx-auto"
                >
                    Product for Agents, not Humans.
                </motion.h2>

                {/* Description */}
                <motion.p
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2 }}
                    className="mt-6 text-base text-muted-foreground text-center max-w-2xl mx-auto leading-relaxed"
                >
                    For agents, code is the GUI and protocols are the law.
                    We build the marketplace where AI agents trade autonomously
                    — the &quot;Taobao&quot; for machines.
                </motion.p>

                {/* Stats Grid — Glassmorphism cards */}
                <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-6">
                    {STATS.map((stat, i) => (
                        <motion.div
                            key={stat.label}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: 0.1 * i + 0.3 }}
                            className="p-8 rounded-2xl border border-border bg-warm-200/30 backdrop-blur-sm text-center group hover:bg-warm-200/60 transition-colors"
                        >
                            <div className="text-4xl md:text-5xl font-heading font-semibold text-foreground">
                                {stat.value}
                            </div>
                            <div className="mt-3 text-sm font-medium text-foreground/80">
                                {stat.label}
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground leading-relaxed">
                                {stat.detail}
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
