import type { OnchainRiskReport } from '@/types/agent';
import { useI18n } from '@/components/i18n/locale-provider';
import { publicChainConfig } from '@/lib/chain-config';
import { AlertTriangle, ExternalLink, Network, ShieldAlert } from 'lucide-react';

const RISK_STYLE: Record<OnchainRiskReport['riskLevel'] | 'info', string> = {
    info: 'border-slate-300 bg-slate-50 text-slate-700',
    low: 'border-sky-300 bg-sky-50 text-sky-700',
    medium: 'border-amber-300 bg-amber-50 text-amber-700',
    high: 'border-orange-300 bg-orange-50 text-orange-700',
    critical: 'border-red-300 bg-red-50 text-red-700',
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseOnchainRiskReport(value: string): OnchainRiskReport | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.chainId !== 'number') return null;
        if (!isRecord(parsed.target) || typeof parsed.target.address !== 'string') return null;
        if (!isRecord(parsed.facts) || !isRecord(parsed.coverage)) return null;
        if (!Array.isArray(parsed.riskSignals) || !Array.isArray(parsed.limitations)) return null;
        if (typeof parsed.riskScore !== 'number' || typeof parsed.riskLevel !== 'string') return null;
        if (typeof parsed.observedAt !== 'string' || typeof parsed.blockNumber !== 'number') return null;
        if (typeof parsed.recommendation !== 'string') return null;
        return parsed as unknown as OnchainRiskReport;
    } catch {
        return null;
    }
}

function AddressLink({ address }: { address: string }) {
    return (
        <a
            href={`${publicChainConfig.explorerUrl}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 break-all text-primary hover:underline"
        >
            {address}
            <ExternalLink className="h-2.5 w-2.5 shrink-0" />
        </a>
    );
}

export function OnchainRiskReportView({ report }: { report: OnchainRiskReport }) {
    const { t } = useI18n();
    const tokenLabel = [report.facts.token?.name, report.facts.token?.symbol ? `(${report.facts.token.symbol})` : '']
        .filter(Boolean)
        .join(' ');

    return (
        <div className="space-y-3">
            <div className={`border p-3 ${RISK_STYLE[report.riskLevel]}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium">
                        <ShieldAlert className="h-4 w-4" />
                        {t('result.onchain.title')}
                    </span>
                    <span className="border border-current px-2 py-0.5 font-mono text-[10px] uppercase">
                        {t(`result.onchain.risk.${report.riskLevel}`)} · {report.riskScore}/100
                    </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed">{report.recommendation}</p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
                <div className="border border-border bg-card p-3 text-[10px]">
                    <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground">
                        <Network className="h-3 w-3" /> {t('result.onchain.target')}
                    </div>
                    <div className="space-y-1 text-muted-foreground">
                        <div><AddressLink address={report.target.address} /></div>
                        <div>{report.target.classification.toUpperCase()} · {report.target.bytecodeSize} bytes</div>
                        {tokenLabel ? <div>{tokenLabel}</div> : null}
                        <div>{t('result.onchain.block')}: {report.blockNumber}</div>
                        <div>{t('result.onchain.observed')}: {new Date(report.observedAt).toLocaleString()}</div>
                    </div>
                </div>

                <div className="border border-border bg-card p-3 text-[10px]">
                    <div className="mb-2 font-medium text-foreground">{t('result.onchain.control')}</div>
                    <div className="space-y-1 text-muted-foreground">
                        <div>
                            <span className="text-foreground">{t('result.onchain.owner')}:</span>{' '}
                            {report.facts.ownership.owner ? <AddressLink address={report.facts.ownership.owner} /> : t('result.onchain.unavailable')}
                        </div>
                        <div>
                            <span className="text-foreground">{t('result.onchain.implementation')}:</span>{' '}
                            {report.facts.proxy.implementation ? <AddressLink address={report.facts.proxy.implementation} /> : t('result.onchain.unavailable')}
                        </div>
                        {report.facts.proxy.admin ? (
                            <div><span className="text-foreground">Admin:</span> <AddressLink address={report.facts.proxy.admin} /></div>
                        ) : null}
                    </div>
                </div>
            </div>

            <div className="border border-border bg-card p-3">
                <div className="mb-2 text-[10px] font-medium text-foreground">{t('result.onchain.signals')}</div>
                <div className="space-y-1.5">
                    {report.riskSignals.map((signal) => (
                        <div key={signal.id} className="border border-border p-2 text-[10px]">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                                <span className="font-medium text-foreground">{signal.title}</span>
                                <span className={`border px-1 py-0.5 uppercase ${RISK_STYLE[signal.severity]}`}>
                                    {signal.severity} · {Math.round(signal.confidence * 100)}%
                                </span>
                            </div>
                            <p className="mt-1 text-muted-foreground">{signal.evidence}</p>
                        </div>
                    ))}
                </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
                <div className="border border-border bg-card p-3 text-[10px]">
                    <div className="mb-2 font-medium text-foreground">{t('result.onchain.coverage')}</div>
                    <div className="space-y-1">
                        {Object.entries(report.coverage).map(([area, status]) => (
                            <div key={area} className="flex justify-between gap-2">
                                <span className="text-muted-foreground">{area}</span>
                                <span className={status === 'measured' ? 'text-green-700' : 'text-amber-700'}>
                                    {t(`result.onchain.coverage.${status}`)}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="border border-amber-300 bg-amber-50/50 p-3 text-[10px]">
                    <div className="mb-2 flex items-center gap-1.5 font-medium text-amber-800">
                        <AlertTriangle className="h-3 w-3" /> {t('result.onchain.limitations')}
                    </div>
                    <ul className="space-y-1 text-amber-800">
                        {report.limitations.map((limitation) => <li key={limitation}>• {limitation}</li>)}
                    </ul>
                </div>
            </div>
        </div>
    );
}
