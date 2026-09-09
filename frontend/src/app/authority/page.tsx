import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowUpRight,
  Ban,
  Check,
  Clock3,
  KeyRound,
  LockKeyhole,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from 'lucide-react';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { getAuthoritySnapshot } from '@/lib/authority-api';
import { publicChainConfig } from '@/lib/chain-config';
import { formatTokenAmount, shortenAddress } from '@/lib/format';
import type {
  AuthorityRecord,
  AuthoritySpendSummary,
  AuthorityTransactionEvidence,
} from '@/types/authority';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent Authority | Agora Mesh',
  description: 'Inspect Hunter permissions, spend limits, payment evidence, and revoke readiness.',
};

const serviceNames: Record<string, string> = {
  'auditor-v1': 'Security Auditor',
  'verifier-v1': 'Verification Agent',
};

function explorerTxUrl(txHash: string): string {
  return `${publicChainConfig.explorerUrl}/tx/${encodeURIComponent(txHash)}`;
}

function explorerAddressUrl(address: string): string {
  return `${publicChainConfig.explorerUrl}/address/${encodeURIComponent(address)}`;
}

function formatUtcTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp * 1_000)) + ' UTC';
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function spendPercent(summary: AuthoritySpendSummary): number {
  const limit = BigInt(summary.limit);
  if (limit === BigInt(0)) return 100;
  const tenths = (BigInt(summary.spent) * BigInt(1_000)) / limit;
  return Math.min(100, Number(tenths) / 10);
}

function serviceName(transaction: AuthorityTransactionEvidence, index: number): string {
  return (transaction.serviceId && serviceNames[transaction.serviceId])
    ?? transaction.serviceId
    ?? `Approved service ${index + 1}`;
}

function statusStyles(status: AuthorityRecord['status']): string {
  if (status === 'active') return 'border-emerald-700/20 bg-emerald-700/10 text-emerald-800';
  if (status === 'revoked') return 'border-destructive/20 bg-destructive/10 text-destructive';
  return 'border-amber-700/20 bg-amber-700/10 text-amber-800';
}

function AuthorityUnavailable({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
      <div className="max-w-3xl rounded-3xl border border-destructive/30 bg-destructive/5 p-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">Authority unavailable</p>
        <h1 className="mt-4 font-heading text-4xl font-semibold">Hunter permissions could not be loaded.</h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">{message}</p>
        <Link href="/authority" className="mt-6 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
          <RefreshCw className="h-4 w-4" /> Retry
        </Link>
      </div>
    </main>
  );
}

export default async function AuthorityPage() {
  let snapshot;
  try {
    snapshot = await getAuthoritySnapshot();
  } catch (error) {
    return (
      <MarketplaceShell>
        <AuthorityUnavailable message={error instanceof Error ? error.message : 'Unknown Authority API error'} />
      </MarketplaceShell>
    );
  }

  const { authority, now, revocation } = snapshot;
  const spendingError = Array.isArray(snapshot.spending) ? undefined : snapshot.spending.error;
  const spending = Array.isArray(snapshot.spending) ? snapshot.spending : [];
  const primarySpend = spending[0];
  const transactions = spending.flatMap((summary) => summary.transactions);
  const remainingSeconds = authority.expiry - now;

  return (
    <MarketplaceShell>
      <main>
        <section className="border-b border-border">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
            <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3 w-3" /> Scoped agent wallet
                </div>
                <h1 className="mt-5 font-heading text-5xl font-semibold tracking-[-0.05em] sm:text-6xl">Hunter Authority</h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
                  One bounded session. Approved recipients, a real daily spend cap, a fixed expiry, and independently inspectable payment evidence.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/authority/manage" className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90">Manage Passkey Authority</Link>
                <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs font-semibold uppercase ${statusStyles(authority.status)}`}>
                  <span className="h-2 w-2 rounded-full bg-current" /> {authority.status}
                </span>
                <span className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">{publicChainConfig.label}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-5 px-5 py-10 sm:px-8 lg:grid-cols-3">
          <article className="rounded-2xl border border-border bg-card p-6 lg:col-span-2">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Spending</p>
                <h2 className="mt-2 font-heading text-3xl font-semibold">Bounded by confirmed evidence</h2>
              </div>
              <WalletCards className="h-5 w-5 text-muted-foreground" />
            </div>

            {primarySpend ? (
              <>
                <div className="mt-8 grid gap-5 sm:grid-cols-3">
                  {[
                    ['Daily limit', primarySpend.limit],
                    [authority.status === 'revoked' ? 'Spent at revoke' : 'Spent today', primarySpend.spent],
                    ['Remaining', primarySpend.remaining],
                  ].map(([label, amount]) => (
                    <div key={label}>
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-2 font-mono text-2xl font-semibold">
                        {formatTokenAmount(amount, primarySpend.asset.decimals, 3)} <span className="text-sm text-muted-foreground">{primarySpend.asset.symbol}</span>
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-7 h-2 overflow-hidden rounded-full bg-secondary" aria-label={`${spendPercent(primarySpend)}% of daily limit spent`}>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${spendPercent(primarySpend)}%` }} />
                </div>
                <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>{spendPercent(primarySpend)}% used {authority.status === 'revoked' ? 'when access was revoked' : 'in the current UTC day'}</span>
                  <span>Source: {primarySpend.evidenceSource === 'x402-receipt-store' ? 'confirmed x402 receipts' : primarySpend.evidenceSource}</span>
                </div>
              </>
            ) : (
              <p className="mt-8 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                {spendingError ?? 'No spend limit is available for this Authority.'}
              </p>
            )}
          </article>

          <article className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Expiration</p>
                <p className="mt-3 font-mono text-3xl font-semibold">
                  {authority.status === 'revoked' ? 'Revoked' : formatRemaining(remainingSeconds)}
                </p>
              </div>
              <Clock3 className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="mt-5 text-sm text-muted-foreground">{formatUtcTimestamp(authority.expiry)}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Payments fail closed once this timestamp is reached. The original session key cannot be restored.</p>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6 lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Permissions</p>
                <h2 className="mt-2 font-heading text-3xl font-semibold">What Hunter can — and cannot — do</h2>
              </div>
              <LockKeyhole className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-7 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-secondary/60 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Allowed</p>
                <ul className="mt-4 space-y-3 text-sm">
                  {['Pay approved agent services', 'Use the scoped x402 session', 'Spend only within the daily U cap'].map((permission) => (
                    <li key={permission} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-emerald-700" /> {permission}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl bg-secondary/60 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Denied</p>
                <ul className="mt-4 space-y-3 text-sm">
                  {['Arbitrary transfers', 'Unknown recipients', 'Payments above cap, after expiry, or after revoke'].map((permission) => (
                    <li key={permission} className="flex gap-2"><X className="mt-0.5 h-4 w-4 text-destructive" /> {permission}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-5 divide-y divide-border rounded-xl border border-border">
              {authority.allowedCalls.map((call, index) => {
                const matchedTransaction = transactions.find((transaction) => transaction.recipient.toLowerCase() === call.to.toLowerCase());
                const label = matchedTransaction ? serviceName(matchedTransaction, index) : `Approved service ${index + 1}`;
                return (
                  <div key={call.to} className="flex flex-col justify-between gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center">
                    <span className="font-medium">{label}</span>
                    <a href={explorerAddressUrl(call.to)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                      {shortenAddress(call.to, 6)} <ArrowUpRight className="h-3 w-3" />
                    </a>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Session</p>
                <h2 className="mt-2 font-heading text-2xl font-semibold">Public identity</h2>
              </div>
              <KeyRound className="h-5 w-5 text-muted-foreground" />
            </div>
            <a href={`https://testnet.altana.network/account/${authority.walletAddress}`} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-1 text-sm underline">Inspect Altana Keystore <ArrowUpRight className="h-3 w-3" /></a>
            <dl className="mt-6 space-y-4 text-sm">
              <div><dt className="text-xs text-muted-foreground">Authority ID</dt><dd className="mt-1 break-all font-mono text-xs">{authority.authorityId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Hunter wallet</dt><dd className="mt-1"><a href={explorerAddressUrl(authority.walletAddress)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:underline">{shortenAddress(authority.walletAddress, 6)} <ArrowUpRight className="h-3 w-3" /></a></dd></div>
              <div><dt className="text-xs text-muted-foreground">Session public key</dt><dd className="mt-1 break-all font-mono text-[11px] leading-5 text-muted-foreground">{shortenAddress(authority.sessionPublicKey, 12)}</dd></div>
              {authority.grantTxHash && <div><dt className="text-xs text-muted-foreground">Grant transaction</dt><dd className="mt-1"><a href={explorerTxUrl(authority.grantTxHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:underline">{shortenAddress(authority.grantTxHash, 6)} <ArrowUpRight className="h-3 w-3" /></a></dd></div>}
              {authority.revokeTxHash && <div><dt className="text-xs text-muted-foreground">Revoke transaction</dt><dd className="mt-1"><a href={explorerTxUrl(authority.revokeTxHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:underline">{shortenAddress(authority.revokeTxHash, 6)} <ArrowUpRight className="h-3 w-3" /></a></dd></div>}
            </dl>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6 lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Payment evidence</p>
                <h2 className="mt-2 font-heading text-3xl font-semibold">Confirmed autonomous spend</h2>
              </div>
              <ReceiptText className="h-5 w-5 text-muted-foreground" />
            </div>
            {transactions.length > 0 ? (
              <div className="mt-6 divide-y divide-border rounded-xl border border-border">
                {transactions.map((transaction, index) => {
                  const summary = spending.find((item) => item.transactions.includes(transaction));
                  return (
                    <div key={transaction.txHash} className="grid gap-3 px-4 py-4 text-sm sm:grid-cols-[1fr_auto_auto] sm:items-center">
                      <div>
                        <p className="font-medium">{serviceName(transaction, index)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatUtcTimestamp(transaction.timestamp)}</p>
                      </div>
                      <p className="font-mono font-semibold">{formatTokenAmount(transaction.amount, summary?.asset.decimals ?? 18, 3)} {summary?.asset.symbol ?? 'U'}</p>
                      <a href={explorerTxUrl(transaction.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">View tx <ArrowUpRight className="h-3 w-3" /></a>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-6 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No confirmed payments in the current spending window.</p>
            )}
          </article>

          <article className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">Emergency control</p>
                <h2 className="mt-2 font-heading text-2xl font-semibold">Revoke access</h2>
              </div>
              <Ban className="h-5 w-5 text-destructive" />
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">Revocation requires an explicit admin confirmation and an onchain transaction. It is intentionally not broadcast from this read-only page.</p>
            {authority.status === 'active' ? (
              <button disabled className="mt-5 w-full cursor-not-allowed rounded-lg bg-destructive px-4 py-2.5 text-sm font-medium text-destructive-foreground opacity-60">
                Revoke — confirmation required
              </button>
            ) : (
              <div className="mt-5 rounded-lg border border-border px-4 py-3 text-sm">Authority is already {authority.status}.</div>
            )}
            {revocation?.negativeTest ? (
              <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${revocation.negativeTest.rejected ? 'border-emerald-700/20 bg-emerald-700/10 text-emerald-800' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                <p className="font-medium">
                  {revocation.negativeTest.rejected ? 'Post-revoke payment rejected' : 'Post-revoke payment was not rejected'}
                </p>
                <p className="mt-1 text-xs leading-5 opacity-80">
                  Tested {formatUtcTimestamp(revocation.negativeTest.testedAt)} with a 1-base-unit U transfer. Session material deleted: {revocation.sessionMaterialDeleted ? 'yes' : 'no'}.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">After confirmation, the negative test must prove that a subsequent payment is rejected.</p>
            )}
            {revocation && (
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                {[
                  ['Checker revoke', revocation.checkerApprovalTxHash],
                  ['Allowance revoke', revocation.permit2AllowanceTxHash],
                  ['Session revoke', revocation.sessionRevokeTxHash],
                ].map(([label, txHash]) => (
                  <a key={label} href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    {label} <ArrowUpRight className="h-3 w-3" />
                  </a>
                ))}
              </div>
            )}
          </article>
        </section>
      </main>
    </MarketplaceShell>
  );
}
