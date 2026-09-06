import type { FindingVerification, HunterRunResult } from '@/types/agent';
import { useI18n } from '@/components/i18n/locale-provider';
import { publicChainConfig } from '@/lib/chain-config';
import { CheckCircle2, FileJson, Star, ExternalLink, ShieldCheck } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { OnchainRiskReportView, parseOnchainRiskReport } from './onchain-risk-report';

interface ResultViewProps {
    result: HunterRunResult;
}

const VERIFICATION_STATUS_STYLE: Record<FindingVerification['status'], string> = {
    confirmed: 'border-green-300 bg-green-50 text-green-700',
    rejected: 'border-red-300 bg-red-50 text-red-700',
    partial: 'border-amber-300 bg-amber-50 text-amber-700',
    inconclusive: 'border-slate-300 bg-slate-50 text-slate-700',
    missed: 'border-orange-300 bg-orange-50 text-orange-700',
};

/**
 * Terminal-style result display for completed missions.
 * Replaces old Card-based layout with consistent terminal widgets.
 */
export function ResultView({ result }: ResultViewProps) {
    const { t } = useI18n();
    const content = result.execution?.result || result.finalMessage || t('result.empty');
    const receipt = result.execution?.receipt;
    const payment = result.execution?.payment;
    const verification = result.verification;
    const onchainRiskReport = result.service.taskType === 'onchain-investigation'
        ? parseOnchainRiskReport(content)
        : null;

    return (
        <div className="space-y-3">
            {/* ─── Final Result ─── */}
            <div className="border border-green-300 bg-green-50 p-3">
                <div className="flex justify-between items-center text-xs mb-2">
                    <span className="flex items-center gap-1.5 text-green-700 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t('result.title')}
                    </span>
                    <div className="flex items-center gap-1.5">
                        {result.evaluation && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-amber-300 bg-amber-50 text-[10px] text-amber-700">
                                <Star className="w-2.5 h-2.5" />
                                {result.evaluation.score}/10
                            </span>
                        )}
                        {result.receiptVerified && (
                            <span className="px-1.5 py-0.5 border border-green-300 text-[10px] text-green-700">
                                {t('result.verified')}
                            </span>
                        )}
                    </div>
                </div>
                <div className="text-xs leading-relaxed text-foreground prose prose-sm max-w-none">
                    {onchainRiskReport ? <OnchainRiskReportView report={onchainRiskReport} /> : <Streamdown>{content}</Streamdown>}
                </div>
            </div>

            {verification ? (
                <div className="border border-teal-300 bg-teal-50/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3">
                        <span className="flex items-center gap-1.5 text-teal-800 font-medium">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {t('result.verificationTitle')}
                        </span>
                        <span className="px-1.5 py-0.5 border border-teal-300 text-[10px] text-teal-800">
                            {verification.report.engine.name}
                            {verification.report.engine.version ? ` ${verification.report.engine.version}` : ''}
                        </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mb-3 text-center text-[10px]">
                        {(['confirmed', 'rejected', 'partial', 'inconclusive', 'missed'] as const).map((status) => (
                            <div key={status} className={`border px-1.5 py-1 ${VERIFICATION_STATUS_STYLE[status]}`}>
                                <div className="font-semibold text-sm">{verification.report.summary[status]}</div>
                                <div>{t(`result.verification.${status}`)}</div>
                            </div>
                        ))}
                    </div>
                    <div className="text-[10px] space-y-1 text-muted-foreground break-all">
                        <div><span className="text-foreground font-medium">{t('result.verifier')}:</span> {verification.service.name}</div>
                        <div><span className="text-foreground font-medium">SourceHash:</span> {verification.report.sourceHash}</div>
                        {verification.report.engine.fallbackReason ? (
                            <div className="text-amber-700">
                                <span className="font-medium">{t('result.verificationFallback')}:</span>{' '}
                                {verification.report.engine.fallbackReason}
                            </div>
                        ) : null}
                        {verification.paymentTx ? (
                            <div className="flex items-center gap-1">
                                <span className="text-foreground font-medium">{t('result.verifierPaymentTx')}:</span>
                                <a
                                    href={`${publicChainConfig.explorerUrl}/tx/${verification.paymentTx}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center gap-0.5"
                                >
                                    {verification.paymentTx.slice(0, 10)}...
                                    <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                            </div>
                        ) : null}
                    </div>
                    {verification.report.verifications.length > 0 ? (
                        <div className="mt-3 space-y-1.5">
                            {verification.report.verifications.map((finding) => (
                                <div key={`${finding.findingId}-${finding.status}`} className="border border-border bg-card p-2 text-[10px]">
                                    <div className="flex flex-wrap items-center justify-between gap-1">
                                        <span className="font-mono font-medium">{finding.findingId}</span>
                                        <span className={`border px-1 py-0.5 ${VERIFICATION_STATUS_STYLE[finding.status]}`}>
                                            {finding.status} · {finding.method}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-muted-foreground">{finding.evidence.note}</p>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {/* ─── Proof of Execution (x402) ─── */}
            {receipt && (
                <div className="border border-border bg-card p-3">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                        <FileJson className="w-3 h-3" />
                        <span className="font-medium">{t('result.proofTitle')}</span>
                    </div>
                    <div className="text-[10px] space-y-1 text-muted-foreground break-all">
                        <div><span className="text-foreground font-medium">{t('result.provider')}:</span> {receipt.provider}</div>
                        <div><span className="text-foreground font-medium">{t('result.signature')}:</span> {receipt.signature}</div>
                        <div><span className="text-foreground font-medium">{t('result.requestHash')}:</span> {receipt.requestHash}</div>
                        {payment?.transaction && (
                            <div className="flex items-center gap-1">
                                <span className="text-foreground font-medium">{t('result.paymentTx')}:</span>
                                <a
                                    href={`${publicChainConfig.explorerUrl}/tx/${payment.transaction}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center gap-0.5"
                                >
                                    {payment.transaction.slice(0, 10)}...
                                    <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
