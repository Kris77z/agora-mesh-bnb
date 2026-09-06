import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Beaker,
  Check,
  Clock3,
  FlaskConical,
  ReceiptText,
  Scale,
  ShieldAlert,
  TriangleAlert,
  WalletCards,
  Wrench,
} from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { getAdvantageReport } from '@/lib/advantage-api';
import { publicChainConfig } from '@/lib/chain-config';
import { formatTokenAmount, shortenAddress } from '@/lib/format';
import type { AdvantageExperiment, MeasuredAuditMetrics, MeasuredDueDiligenceMetrics, MeasuredTokenRiskMetrics, ModelOnlyBaselineCandidate, PartialDueDiligenceMetrics } from '@/types/advantage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent Advantage | Agora Mesh',
  description: 'Evidence-backed TermiX experiment metrics for Agora Mesh autonomous workflows.',
};

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusClass(status: AdvantageExperiment['status']): string {
  if (status === 'completed') return 'border-emerald-700/20 bg-emerald-700/10 text-emerald-800';
  if (status === 'partial') return 'border-amber-700/20 bg-amber-700/10 text-amber-800';
  return 'border-border bg-secondary text-muted-foreground';
}

function formatPartsPerMillion(parts: number): string {
  return `${(parts / 10_000).toFixed(2)}%`;
}

function pendingPanel(title: string, reason: string) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> {title} · Pending</div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{reason}</p>
    </div>
  );
}

function measuredAuditPanel(metrics: MeasuredAuditMetrics) {
  const verifier = metrics.verifier;
  const quality = metrics.quality;
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-700/20 bg-emerald-700/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase text-emerald-800"><Check className="h-3 w-3" /> Agent run measured</div>
          <p className="mt-3 text-xs text-muted-foreground">Source: {metrics.missionSource === 'live-run' ? 'persistent live trace' : 'recovered signed evidence'}</p>
        </div>
        <Link href={`/tasks/${encodeURIComponent(metrics.missionId)}`} className="inline-flex items-center gap-2 text-sm font-medium">Inspect task <ArrowRight className="h-4 w-4" /></Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-secondary/60 p-4"><Clock3 className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Evidence window</p><p className="mt-1 font-mono text-2xl font-semibold">{formatDuration(metrics.durationMs)}</p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><WalletCards className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Confirmed cost</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.cost ? formatTokenAmount(metrics.cost.amount, metrics.cost.asset.decimals, 3) : '—'} <span className="text-sm text-muted-foreground">{metrics.cost?.asset.symbol}</span></p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Critical / high</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.auditorCriticalHighFindings}<span className="text-sm text-muted-foreground">/{metrics.auditorFindings}</span></p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><ReceiptText className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Signed receipts</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.signedReceipts}</p></div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Transaction evidence</p>
          <div className="mt-3 space-y-2">
            {metrics.confirmedTransactions.map((txHash, index) => (
              <a key={txHash} href={`${publicChainConfig.explorerUrl}/tx/${txHash}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2 font-mono text-xs hover:bg-secondary">
                <span>{index === 0 ? 'Auditor' : 'Verifier'} · {shortenAddress(txHash, 6)}</span><ArrowUpRight className="h-3 w-3" />
              </a>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Paid verifier outcome</p>
          {verifier ? (
            <>
              <p className="mt-3 text-sm">{verifier.engine.name}@{verifier.engine.version ?? 'unknown'} · {verifier.checks} checks</p>
              <div className="mt-3 flex flex-wrap gap-2 font-mono text-xs">{Object.entries(verifier.summary).map(([label, count]) => <span key={label} className="rounded-full border border-border px-2.5 py-1">{label} {count}</span>)}</div>
              {verifier.engine.fallbackReason && <p className="mt-3 flex gap-2 text-xs leading-5 text-amber-800"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Historical paid run fell back from Slither: {verifier.engine.fallbackReason}</p>}
            </>
          ) : <p className="mt-3 text-sm text-muted-foreground">No independent verifier evidence.</p>}
        </div>
      </div>

      <p className="mt-5 text-xs leading-5 text-muted-foreground">Hunter internal evaluation: {metrics.hunterEvaluationScore}/10. This is shown as an operational signal, not an independent quality score.</p>
      {quality && (
        <div className="mt-5 rounded-xl border border-emerald-700/20 bg-emerald-700/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Reviewed ground-truth score</p>
            <span className="font-mono text-[10px] text-muted-foreground">{quality.benchmarkId}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs text-muted-foreground">Precision</p><p className="mt-1 font-mono text-2xl font-semibold">{(quality.precision * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">Recall</p><p className="mt-1 font-mono text-2xl font-semibold">{(quality.recall * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">Evidence complete</p><p className="mt-1 font-mono text-2xl font-semibold">{(quality.evidenceCompleteness * 100).toFixed(1)}%</p></div>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">TP {quality.truePositives} · FP {quality.falsePositives} · FN {quality.falseNegatives}. These values are source-hash bound and scored against the reviewed benchmark.</p>
        </div>
      )}
    </div>
  );
}

function measuredTokenRiskPanel(metrics: MeasuredTokenRiskMetrics) {
  const enrichment = metrics.enrichment;
  const tokenDecimals = metrics.target.token?.decimals ?? 18;
  const tokenSymbol = metrics.target.token?.symbol ?? 'token';
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-700/20 bg-emerald-700/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase text-emerald-800"><Check className="h-3 w-3" /> Paid Investigator run measured</div>
          <p className="mt-3 text-xs text-muted-foreground">Source: persistent live trace · observed block {metrics.target.blockNumber}</p>
        </div>
        <Link href={`/tasks/${encodeURIComponent(metrics.missionId)}`} className="inline-flex items-center gap-2 text-sm font-medium">Inspect task <ArrowRight className="h-4 w-4" /></Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-secondary/60 p-4"><Clock3 className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Evidence window</p><p className="mt-1 font-mono text-2xl font-semibold">{formatDuration(metrics.durationMs)}</p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><WalletCards className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Confirmed cost</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.cost ? formatTokenAmount(metrics.cost.amount, metrics.cost.asset.decimals, 3) : '—'} <span className="text-sm text-muted-foreground">{metrics.cost?.asset.symbol}</span></p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Risk signal score</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.riskScore}<span className="text-sm text-muted-foreground">/100 · {metrics.riskLevel}</span></p></div>
        <div className="rounded-xl bg-secondary/60 p-4"><ReceiptText className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Signals / high+</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.riskSignals}<span className="text-sm text-muted-foreground">/{metrics.highCriticalSignals}</span></p></div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Target evidence</p>
          <a href={`${publicChainConfig.explorerUrl}/address/${metrics.target.address}`} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2 font-mono text-xs hover:bg-secondary"><span>{metrics.target.classification.toUpperCase()} · {shortenAddress(metrics.target.address, 6)}</span><ArrowUpRight className="h-3 w-3" /></a>
          <p className="mt-3 text-xs text-muted-foreground">Paid report coverage: {metrics.coverage.measured}/{metrics.coverage.total}.{enrichment ? ` Bound post-run coverage: ${enrichment.coverage.postRunMeasured}/${enrichment.coverage.total}.` : ''} Risk signals are evidence-bound heuristics, not exploit proof.</p>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Payment & receipt evidence</p>
          <div className="mt-3 space-y-2">
            {metrics.confirmedTransactions.map((txHash) => <a key={txHash} href={`${publicChainConfig.explorerUrl}/tx/${txHash}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg bg-secondary/60 px-3 py-2 font-mono text-xs hover:bg-secondary"><span>x402 · {shortenAddress(txHash, 6)}</span><ArrowUpRight className="h-3 w-3" /></a>)}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{metrics.signedReceipts} signed result receipt · Hunter operational score {metrics.hunterEvaluationScore}/10.</p>
        </div>
      </div>

      {metrics.securityReview && (
        <div className="mt-5 rounded-xl border border-emerald-700/20 bg-emerald-700/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Independent Security Agent replay</p>
            <span className="rounded-full border border-emerald-700/20 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-emerald-800">{metrics.securityReview.conclusion.status}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs text-muted-foreground">Confirmed checks</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.securityReview.summary.confirmed}<span className="text-sm text-muted-foreground">/{metrics.securityReview.summary.total}</span></p></div>
            <div><p className="text-xs text-muted-foreground">Mismatches</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.securityReview.summary.mismatched}</p></div>
            <div><p className="text-xs text-muted-foreground">Replay score</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.securityReview.conclusion.replayedRiskScore}<span className="text-sm text-muted-foreground">/100</span></p></div>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{metrics.securityReview.serviceId} · block-bound {metrics.securityReview.engine.method} via {metrics.securityReview.engine.endpoint}. Independent transport: {metrics.securityReview.engine.independentTransport ? 'yes' : 'no'}. {metrics.securityReview.paid ? 'Included in the paid mission.' : 'Post-run validation; no additional payment claimed.'}</p>
        </div>
      )}

      {enrichment && (
        <div className="mt-5 rounded-xl border border-sky-700/20 bg-sky-700/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-800">Post-run index & DEX enrichment</p>
            <span className="rounded-full border border-sky-700/20 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-sky-800">{enrichment.coverage.postRunMeasured}/{enrichment.coverage.total} measured</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">V2 U / WBNB reserves</p><p className="mt-1 font-mono text-sm font-semibold">{enrichment.liquidity.reserveTokenRaw ? formatTokenAmount(enrichment.liquidity.reserveTokenRaw, tokenDecimals, 4) : '—'} {tokenSymbol} / {enrichment.liquidity.reserveWrappedNativeRaw ? formatTokenAmount(enrichment.liquidity.reserveWrappedNativeRaw, 18, 6) : '—'} WBNB</p></div>
            <div><p className="text-xs text-muted-foreground">V3 active pools</p><p className="mt-1 font-mono text-2xl font-semibold">{enrichment.liquidity.activeV3Pools}<span className="text-sm text-muted-foreground">/{enrichment.liquidity.discoveredV3Pools}</span></p></div>
            <div><p className="text-xs text-muted-foreground">Recent transfers</p><p className="mt-1 font-mono text-2xl font-semibold">{enrichment.recentTransactions.status === 'measured' ? enrichment.recentTransactions.activity.transfers : '—'}</p></div>
            <div><p className="text-xs text-muted-foreground">Holder concentration</p><p className="mt-1 font-mono text-sm font-semibold">{enrichment.holderConcentration.status === 'measured' ? `${enrichment.holderConcentration.holderCount} holders · top 1 ${formatPartsPerMillion(enrichment.holderConcentration.top1PartsPerMillion)}` : 'Unavailable'}</p></div>
          </div>
          {enrichment.recentTransactions.status === 'measured' && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Blocks {enrichment.recentTransactions.blockRange.from}–{enrichment.recentTransactions.blockRange.to}: {enrichment.recentTransactions.activity.uniqueTransactions} transactions, {enrichment.recentTransactions.activity.mints} mints, {enrichment.recentTransactions.activity.burns} burns, {formatTokenAmount(enrichment.recentTransactions.activity.transferredRaw, tokenDecimals, 4)} {tokenSymbol} transferred.</p>
          )}
          {enrichment.holderConcentration.status === 'measured' && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Complete block-{enrichment.holderConcentration.snapshotBlock} holder snapshot: top 5 {formatPartsPerMillion(enrichment.holderConcentration.top5PartsPerMillion)}, top 10 {formatPartsPerMillion(enrichment.holderConcentration.top10PartsPerMillion)}. Every indexed holder balance was read at one locked block and the exact sum reconciles to totalSupply.</p>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{enrichment.liquidity.interpretation} {enrichment.quote.status === 'quote-only' && enrichment.quote.outputWrappedNativeRaw ? `Read-only quote: ${formatTokenAmount(enrichment.quote.inputTokenRaw, tokenDecimals, 4)} ${tokenSymbol} → ${formatTokenAmount(enrichment.quote.outputWrappedNativeRaw, 18, 8)} WBNB.` : 'No route quote was available.'} This is block-bound post-run evidence with no additional payment.</p>
          {enrichment.sellabilityExecution ? (
            <p className="mt-3 flex gap-2 text-xs leading-5 text-emerald-800"><BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Executed sellability confirmed: {formatTokenAmount(enrichment.sellabilityExecution.inputAmountRaw, tokenDecimals, 4)} {tokenSymbol} sold for {formatTokenAmount(enrichment.sellabilityExecution.outputAmountRaw, 18, 8)} WBNB on PancakeSwap V2 at block {enrichment.sellabilityExecution.blockNumber}; maximum slippage {(enrichment.sellabilityExecution.slippageBps / 100).toFixed(2)}%, final Router allowance zero. <a href={`${publicChainConfig.explorerUrl}/tx/${enrichment.sellabilityExecution.swapTransaction}`} target="_blank" rel="noreferrer" className="font-medium underline">Inspect swap</a>.</p>
          ) : (
            <p className="mt-3 flex gap-2 text-xs leading-5 text-amber-800"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Quote-only is not a successful swap or sellability proof. The V2 token reserve represents {enrichment.liquidity.tokenReservePartsPerBillionOfSupply ?? '—'} parts per billion of reported supply.</p>
          )}
        </div>
      )}

      {metrics.limitations.length > 0 && <p className="mt-5 flex gap-2 text-xs leading-5 text-amber-800"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {metrics.limitations.join(' ')}</p>}
    </div>
  );
}

function measuredDueDiligencePanel(metrics: MeasuredDueDiligenceMetrics) {
  return (
    <div className="rounded-2xl border border-emerald-700/20 bg-emerald-700/5 p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-700/20 bg-emerald-700/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase text-emerald-800"><BadgeCheck className="h-3 w-3" /> Paid Experiment 3 · Completed</div>
          <p className="mt-3 text-xs text-muted-foreground">Auditor + finding verifier + Investigator + risk verifier, reconciled across two persisted paid phases.</p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{formatDuration(metrics.durationMs)} · {formatTokenAmount(metrics.cost.amount, metrics.cost.asset.decimals, 3)} {metrics.cost.asset.symbol} net</span>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-background/70 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Decision</p><p className="mt-1 font-mono text-xl font-semibold">{metrics.decision.status}</p></div>
        <div className="rounded-xl bg-background/70 p-4"><Wrench className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Audit / missed detections</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.audit.findings}<span className="text-sm text-muted-foreground">/{metrics.audit.verifierSummary.missed}</span></p></div>
        <div className="rounded-xl bg-background/70 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Onchain risk</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.onchain.riskScore}<span className="text-sm text-muted-foreground">/100 · {metrics.onchain.riskLevel}</span></p></div>
        <div className="rounded-xl bg-background/70 p-4"><BadgeCheck className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Risk replay</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.onchain.verifierSummary.confirmed}<span className="text-sm text-muted-foreground">/{metrics.onchain.verifierSummary.total}</span></p></div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Four confirmed service payments</p>
          <div className="mt-3 space-y-2">{metrics.payments.map((payment) => <a key={payment.transaction} href={`${publicChainConfig.explorerUrl}/tx/${payment.transaction}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg bg-background/70 px-3 py-2 font-mono text-xs"><span>{payment.serviceId} · {shortenAddress(payment.transaction, 6)}</span><ArrowUpRight className="h-3 w-3" /></a>)}</div>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Reconciliation & cleanup</p>
          <p className="mt-3 text-sm">Net provider spend {formatTokenAmount(metrics.reconciliation.netProviderSpendRaw, metrics.cost.asset.decimals, 3)} {metrics.cost.asset.symbol}; orphaned {formatTokenAmount(metrics.reconciliation.orphanedAuditorSettlementRaw, metrics.cost.asset.decimals, 3)} {metrics.cost.asset.symbol} settlement fully refunded.</p>
          <p className="mt-3 text-xs leading-5 text-emerald-800">Both Authorities revoked · Permit2 allowance zero · session material deleted · post-revoke negative tests rejected.</p>
          <div className="mt-3 flex gap-3 text-xs"><a href={`${publicChainConfig.explorerUrl}/tx/${metrics.reconciliation.orphanedAuditorSettlementTx}`} target="_blank" rel="noreferrer" className="underline">Orphan tx</a><a href={`${publicChainConfig.explorerUrl}/tx/${metrics.reconciliation.refundTx}`} target="_blank" rel="noreferrer" className="underline">Refund tx</a></div>
        </div>
      </div>
      <p className="mt-5 text-xs leading-5 text-amber-800">{metrics.decision.reasons.join(' ')}</p>
    </div>
  );
}

function partialDueDiligencePanel(metrics: PartialDueDiligenceMetrics) {
  const payment = metrics.reusedPaidInvestigation;
  return (
    <div className="rounded-2xl border border-amber-700/20 bg-amber-700/5 p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-700/20 bg-amber-700/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase text-amber-800"><TriangleAlert className="h-3 w-3" /> Same-target candidate · Partial</div>
          <p className="mt-3 text-xs text-muted-foreground">Verified implementation source + reused paid Investigator evidence + local Slither verification. This is not a new paid end-to-end Experiment 3 run.</p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">synthesis {formatDuration(metrics.durationMs)} · no new payment</span>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-background/70 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Decision</p><p className="mt-1 font-mono text-xl font-semibold">{metrics.decision.status}</p></div>
        <div className="rounded-xl bg-background/70 p-4"><Wrench className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Unreviewed detections</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.verifier.uncoveredDetections}</p></div>
        <div className="rounded-xl bg-background/70 p-4"><ShieldAlert className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Onchain risk</p><p className="mt-1 font-mono text-2xl font-semibold">{metrics.onchain.riskScore}<span className="text-sm text-muted-foreground">/100 · {metrics.onchain.riskLevel}</span></p></div>
        <div className="rounded-xl bg-background/70 p-4"><BadgeCheck className="h-4 w-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">Evidence bindings</p><p className="mt-1 font-mono text-2xl font-semibold">{Object.values(metrics.bindings).filter(Boolean).length}<span className="text-sm text-muted-foreground">/{Object.keys(metrics.bindings).length}</span></p></div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Bound target</p>
          <a href={`${publicChainConfig.explorerUrl}/address/${metrics.target.proxy}`} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-background/70 px-3 py-2 font-mono text-xs"><span>Proxy · {shortenAddress(metrics.target.proxy, 6)}</span><ArrowUpRight className="h-3 w-3" /></a>
          <a href={`${publicChainConfig.explorerUrl}/address/${metrics.target.implementation}#code`} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-background/70 px-3 py-2 font-mono text-xs"><span>Implementation · {shortenAddress(metrics.target.implementation, 6)}</span><ArrowUpRight className="h-3 w-3" /></a>
          <p className="mt-3 break-all font-mono text-[10px] leading-5 text-muted-foreground">{metrics.target.sourceHash} · block {metrics.target.reportBlock}</p>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Execution provenance</p>
          <p className="mt-3 text-sm">Auditor: {metrics.auditor.status} · {metrics.auditor.provider}/{metrics.auditor.model} · {formatDuration(metrics.auditor.durationMs)} · {metrics.auditor.findings} scoped findings · {metrics.verifier.summary.partial} structurally partial · {metrics.verifier.summary.inconclusive} inconclusive · Slither {metrics.verifier.engine.version ?? 'unknown'} · onchain review {metrics.onchain.reviewStatus}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Reused paid mission {payment.missionId}: {payment.amount} base units {payment.currency}. Transaction {shortenAddress(payment.transactionHash, 6)}. No new Authority or x402 payment was created for this candidate.</p>
          {metrics.auditor.failureReason && <p className="mt-3 text-xs leading-5 text-amber-800">Auditor unavailable: {metrics.auditor.failureReason} Zero model findings is not a clean-audit result.</p>}
        </div>
      </div>
      <p className="mt-5 text-xs leading-5 text-amber-800">{metrics.decision.reasons.join(' ')}</p>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">Static detections remain unreviewed and may include false positives; controlled baseline and independent human ground truth are still pending.</p>
    </div>
  );
}

function toolReferencePanel(reference: NonNullable<AdvantageExperiment['toolReference']>) {
  return (
    <div className="rounded-2xl border border-sky-700/20 bg-sky-700/5 p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-800"><Wrench className="h-3.5 w-3.5" /> Tool-only reference · Measured</div>
          <p className="mt-2 text-sm">{reference.tool} {reference.version} · {formatDuration(reference.durationMs)} · {reference.detections} detections</p>
        </div>
        <span className="rounded-full border border-sky-700/20 bg-sky-700/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-sky-800">Supplemental reference</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Precision</p><p className="mt-1 font-mono text-xl font-semibold">{(reference.quality.precision * 100).toFixed(1)}%</p></div>
        <div><p className="text-xs text-muted-foreground">Recall</p><p className="mt-1 font-mono text-xl font-semibold">{(reference.quality.recall * 100).toFixed(1)}%</p></div>
        <div><p className="text-xs text-muted-foreground">Ground truth</p><p className="mt-1 font-mono text-xl font-semibold">TP {reference.quality.truePositives} · FP {reference.quality.falsePositives} · FN {reference.quality.falseNegatives}</p></div>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">Reproducible local static analysis at {reference.cost.amount} {reference.cost.currency}. It is a supplemental tool-only reference; the official comparison is reported separately below.</p>
    </div>
  );
}

function modelCandidatePanel(candidate: ModelOnlyBaselineCandidate) {
  const outcome = candidate.kind === 'contract-audit'
    ? {
        firstLabel: 'Findings / TP',
        firstValue: `${candidate.outcome.findings} / ${candidate.outcome.truePositives}`,
        secondLabel: 'Severity accuracy',
        secondValue: `${(candidate.outcome.severityAccuracy * 100).toFixed(1)}%`,
        detail: `Post-freeze candidate scoring: FP ${candidate.outcome.falsePositives} · FN ${candidate.outcome.falseNegatives}.`,
      }
    : candidate.kind === 'token-risk'
      ? {
          firstLabel: 'Risk signals',
          firstValue: String(candidate.outcome.riskSignals),
          secondLabel: 'RPC / model',
          secondValue: `${formatDuration(candidate.outcome.rpcDurationMs)} / ${formatDuration(candidate.outcome.modelDurationMs)}`,
          detail: candidate.outcome.recommendation,
        }
      : {
          firstLabel: 'Trust decision',
          firstValue: candidate.outcome.trustDecision,
          secondLabel: 'Raw Slither signals',
          secondValue: String(candidate.outcome.rawSlitherDetections),
          detail: `Slither ${formatDuration(candidate.outcome.slitherDurationMs)} · ${candidate.outcome.postFreezeCorrections} post-freeze operator corrections recorded.`,
        };
  return (
    <div className="rounded-2xl border border-violet-700/20 bg-violet-700/5 p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-violet-800"><FlaskConical className="h-3.5 w-3.5" /> Ordinary-model candidate · Measured</div>
          <p className="mt-2 text-sm">{candidate.model.provider}/{candidate.model.model} · {formatDuration(candidate.durationMs)} · {candidate.totalTokens.toLocaleString('en-US')} tokens</p>
        </div>
        <span className="rounded-full border border-amber-700/20 bg-amber-700/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-amber-800">Not controlled</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div><p className="text-xs text-muted-foreground">{outcome.firstLabel}</p><p className="mt-1 font-mono text-xl font-semibold">{outcome.firstValue}</p></div>
        <div><p className="text-xs text-muted-foreground">{outcome.secondLabel}</p><p className="mt-1 font-mono text-xl font-semibold">{outcome.secondValue}</p></div>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{outcome.detail}</p>
      <p className="mt-3 flex gap-2 text-xs leading-5 text-amber-800"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> LLM context excluded Agent conclusions, but the orchestrator was not an independent human. Provider invoice cost is unavailable, so this does not complete the controlled baseline or cost comparison.</p>
    </div>
  );
}

function measuredBaselinePanel(experiment: AdvantageExperiment) {
  if (experiment.baseline.status !== 'measured') return pendingPanel('Without marketplace Agent', experiment.baseline.reason);
  const baseline = experiment.baseline;
  const comparison = experiment.comparison;
  return (
    <div className="rounded-xl border border-violet-700/20 bg-violet-700/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-violet-800"><FlaskConical className="h-3.5 w-3.5" /> Without marketplace Agent · Measured</div>
        <span className="rounded-full border border-violet-700/20 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-violet-800">{baseline.reviewerType.replace('-', ' ')}</span>
      </div>
      <p className="mt-3 text-sm">{baseline.model.provider}/{baseline.model.model} · {formatDuration(baseline.durationMs)} · ${baseline.costUsd.toFixed(4)} estimated · {baseline.totalTokens.toLocaleString('en-US')} tokens</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div><p className="text-xs text-muted-foreground">Baseline quality</p><p className="mt-1 font-mono text-2xl font-semibold">{baseline.qualityScore.toFixed(1)}<span className="text-sm text-muted-foreground">/{baseline.qualityScale}</span></p></div>
        <div><p className="text-xs text-muted-foreground">Agent quality</p><p className="mt-1 font-mono text-2xl font-semibold">{comparison?.agentQualityScore.toFixed(1) ?? '—'}<span className="text-sm text-muted-foreground">/100</span></p></div>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{baseline.qualitySummary}</p>
      {comparison && <p className="mt-3 text-xs leading-5 text-violet-800">Quality delta {comparison.qualityDelta >= 0 ? '+' : ''}{comparison.qualityDelta.toFixed(1)} points · {comparison.result}</p>}
      {comparison && <p className="mt-3 text-xs leading-5 text-muted-foreground">Recorded elapsed time: Agora Mesh {formatDuration(baseline.durationMs + comparison.durationDeltaMs)} vs baseline {formatDuration(baseline.durationMs)}. This comparison does not establish a speed or dollar-cost advantage.</p>}
      {experiment.id === 'due-diligence' && <p className="mt-3 text-xs leading-5 text-muted-foreground">The 34m 52s delivery window spans two mission phases: about 3m 22s executing and 31m 31s between phases during recovery and supplemental execution. The full window remains the reported user delivery time; the phase sum is not a replacement benchmark.</p>}
      <p className="mt-3 text-xs leading-5 text-amber-800">Reviewer disclosure: AI/operator, not an independent human. {comparison?.costCaveat ?? baseline.costBasis}</p>
      <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted-foreground">{baseline.artifact} · {baseline.artifactHash}</p>
    </div>
  );
}

function ExperimentCard({ experiment, index }: { experiment: AdvantageExperiment; index: number }) {
  return (
    <article className="rounded-3xl border border-border bg-card p-6 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3"><span className="font-mono text-xs text-muted-foreground">EXPERIMENT 0{index + 1}</span><span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase ${statusClass(experiment.status)}`}>{experiment.status}</span></div>
          <h2 className="mt-4 font-heading text-4xl font-semibold">{experiment.name}</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{experiment.task}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">{experiment.agentWorkflow.map((step, stepIndex) => <span key={step} className="inline-flex items-center gap-2"><span className="rounded-full border border-border px-3 py-1.5">{step}</span>{stepIndex < experiment.agentWorkflow.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}</span>)}</div>
      </div>
      <div className="mt-7">
        {experiment.agent.status === 'measured'
          ? experiment.agent.kind === 'contract-audit'
            ? measuredAuditPanel(experiment.agent)
            : experiment.agent.kind === 'token-risk'
              ? measuredTokenRiskPanel(experiment.agent)
              : measuredDueDiligencePanel(experiment.agent)
          : experiment.agent.status === 'partial'
            ? partialDueDiligencePanel(experiment.agent)
          : pendingPanel('Agent workflow', experiment.agent.reason)}
      </div>
      {experiment.toolReference ? <div className="mt-4">{toolReferencePanel(experiment.toolReference)}</div> : null}
      {experiment.modelCandidate ? <div className="mt-4">{modelCandidatePanel(experiment.modelCandidate)}</div> : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {measuredBaselinePanel(experiment)}
        {experiment.groundTruth.status === 'reviewed' ? (
          <div className="rounded-xl border border-emerald-700/20 bg-emerald-700/5 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800"><BadgeCheck className="h-3.5 w-3.5" /> Ground truth · Reviewed</div>
            <p className="mt-3 text-sm">{experiment.groundTruth.benchmarkId} · {experiment.groundTruth.findings} known findings</p>
            <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted-foreground">{experiment.groundTruth.sourceHash}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{experiment.groundTruth.reviewMethod.join(' · ')}</p>
            {experiment.groundTruth.reviewerType && <p className="mt-2 text-xs leading-5 text-amber-800">Reviewer: {experiment.groundTruth.reviewerType.replace('-', ' ')} · independent human: no</p>}
          </div>
        ) : pendingPanel('Ground truth', experiment.groundTruth.reason)}
      </div>
    </article>
  );
}

export default async function AdvantagePage() {
  let report;
  try {
    report = await getAdvantageReport();
  } catch (error) {
    return (
      <MarketplaceShell>
        <main className="mx-auto max-w-7xl px-5 py-16 sm:px-8"><div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-8"><h1 className="font-heading text-4xl font-semibold">Advantage evidence unavailable</h1><p className="mt-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Unknown Advantage API error'}</p></div></main>
      </MarketplaceShell>
    );
  }

  return (
    <MarketplaceShell>
      <main>
        <section className="border-b border-border">
          <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-24">
            <div className="max-w-4xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"><FlaskConical className="h-3 w-3" /> TermiX Agent Advantage</div>
              <h1 className="mt-6 font-heading text-5xl font-semibold tracking-[-0.05em] sm:text-7xl">Evidence before claims.</h1>
              <p className="mt-6 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">Three real tasks are measured both with the marketplace Agent and without it. Time, estimated cost, quality, raw outputs, and reviewer provenance remain separate and auditable.</p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-7">
              <div className="rounded-2xl border border-border bg-card p-5"><Beaker className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Experiments defined</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.experiments}</p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><BadgeCheck className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Measured Agent runs</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.measuredAgentRuns}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><Wrench className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Tool references</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.measuredToolReferences}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><BadgeCheck className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Independent reviews</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.measuredIndependentReviews}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><FlaskConical className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Post-run enrichments</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.measuredEnrichments}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><FlaskConical className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Model candidates</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.measuredModelCandidates}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
              <div className="rounded-2xl border border-border bg-card p-5"><Scale className="h-4 w-4 text-muted-foreground" /><p className="mt-4 text-xs text-muted-foreground">Completed comparisons</p><p className="mt-1 font-mono text-3xl font-semibold">{report.summary.completedComparisons}<span className="text-sm text-muted-foreground">/{report.summary.experiments}</span></p></div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
          <div className="rounded-2xl border border-border bg-card p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Methodology lock</p>
            <div className="mt-5 grid gap-5 md:grid-cols-3">{Object.entries(report.methodology).map(([label, description]) => <div key={label}><p className="text-sm font-medium capitalize">{label}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p></div>)}</div>
          </div>
          <div className="mt-8 space-y-6">{report.experiments.map((experiment, index) => <ExperimentCard key={experiment.id} experiment={experiment} index={index} />)}</div>
        </section>
      </main>
    </MarketplaceShell>
  );
}
