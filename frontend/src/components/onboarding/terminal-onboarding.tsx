'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '@/components/i18n/locale-provider';
import { useWallet } from '@/hooks/use-wallet';

/* ─── Types ─── */
type Style = 'cmd' | 'out' | 'ok' | 'dim' | 'accent' | 'err';
type InputMode = 'none' | 'enter' | 'text' | 'choice';
/**
 * New flow (wallet-last):
 *   boot → name → confirm → wallet_connect → register → done
 */
type Phase = 'boot' | 'name' | 'confirm' | 'wallet_connect' | 'register' | 'done';

interface Line { text: string; style: Style }
interface PendingInput { mode: InputMode; prompt: string }

const CLS: Record<Style, string> = {
    cmd: 'text-foreground font-semibold',
    out: 'text-muted-foreground',
    ok: 'text-green-600 dark:text-green-400',
    dim: 'text-muted-foreground/50',
    accent: 'text-primary',
    err: 'text-red-500',
};

/* ─── Boot sequence factory ─── */
function createBootSequence(t: (key: string, vars?: Record<string, string | number>) => string) {
    return {
        queue: [
            { text: t('onboarding.terminal.command.init'), style: 'cmd' as Style },
            { text: '', style: 'out' as Style },
            { text: '  ╔══════════════════════════════════════════╗', style: 'accent' as Style },
            { text: '  ║          A G O R A   M E S H             ║', style: 'accent' as Style },
            { text: '  ║         Agora Mesh Protocol              ║', style: 'accent' as Style },
            { text: '  ╚══════════════════════════════════════════╝', style: 'accent' as Style },
            { text: '', style: 'out' as Style },
            { text: t('onboarding.terminal.target'), style: 'dim' as Style },
            { text: t('onboarding.terminal.ready'), style: 'out' as Style },
            { text: '', style: 'out' as Style },
        ],
        pendingInput: { mode: 'enter' as InputMode, prompt: t('onboarding.terminal.prompt.begin') },
        phase: 'boot' as Phase,
    };
}

/* ─── Component ─── */
interface Props { onComplete?: () => void }

export function TerminalOnboarding({ onComplete }: Props) {
    const { t } = useI18n();
    const boot = createBootSequence(t);
    const wallet = useWallet();

    const [lines, setLines] = useState<Line[]>([]);
    const [queue, setQueue] = useState<Line[]>(() => boot.queue);
    const [typing, setTyping] = useState<{ line: Line; pos: number } | null>(null);
    const [phase, setPhase] = useState<Phase>(() => boot.phase);
    const [input, setInput] = useState('');
    const [inputMode, setInputMode] = useState<InputMode>('none');
    const [prompt, setPrompt] = useState('');
    const [pendingInput, setPendingInput] = useState<PendingInput | null>(() => boot.pendingInput);
    const [agentName, setAgentName] = useState('');

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    /* ─ Auto scroll + focus ─ */
    useEffect(() => { scrollRef.current?.scrollTo({ top: 99999 }); }, [lines, typing?.pos]);
    useEffect(() => { if (inputMode !== 'none') inputRef.current?.focus(); }, [inputMode]);

    /* ═══ Typewriter engine ═══ */
    useEffect(() => {
        if (typing) {
            if (typing.pos >= typing.line.text.length) {
                setLines(p => [...p, typing.line]); setTyping(null); return;
            }
            const speed = typing.line.text.length > 50 ? 12 : 20;
            const timer = setTimeout(() => setTyping({ ...typing, pos: typing.pos + 1 }), speed);
            return () => clearTimeout(timer);
        }
        if (queue.length > 0) {
            const [next, ...rest] = queue;
            if (next.text === '') { setLines(p => [...p, next]); setQueue(rest); }
            else { setTyping({ line: next, pos: 0 }); setQueue(rest); }
        }
    }, [typing, queue]);

    /* Activate input after queue drains */
    useEffect(() => {
        if (queue.length === 0 && !typing && pendingInput) {
            setInputMode(pendingInput.mode); setPrompt(pendingInput.prompt);
            setPendingInput(null);
        }
    }, [queue.length, typing, pendingInput]);

    const pushLines = useCallback((newLines: Line[], mode: InputMode = 'none', promptText = '') => {
        setInputMode('none'); setInput('');
        setQueue(p => [...p, ...newLines]);
        if (mode !== 'none') setPendingInput({ mode, prompt: promptText });
    }, []);

    /* ═══ Prepare personal workspace ═══ */
    const prepareWorkspace = useCallback(async (walletAddr: string) => {
        try {
            // A personal workspace does not publish a provider to the Registry.
            localStorage.setItem('rebel_agent_profile', JSON.stringify({ name: agentName, walletAddress: walletAddr }));

            if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
                pushLines([
                    { text: '✓ ████████████████████ 100%', style: 'ok' },
                    { text: '', style: 'out' },
                    { text: t('onboarding.terminal.demoModeNotice'), style: 'accent' },
                ]);
                setPhase('done');
            } else {
                pushLines([
                    { text: '✓ ████████████████████ 100%', style: 'ok' },
                    { text: t('onboarding.terminal.registered', { name: agentName }), style: 'ok' },
                    { text: t('onboarding.terminal.readyForDeployment'), style: 'ok' },
                    { text: '', style: 'out' },
                ], 'enter', t('onboarding.terminal.prompt.launchDashboard'));
                setPhase('done');
            }
        } catch (err) {
            pushLines([
                { text: `✗ ${err instanceof Error ? err.message : t('onboarding.error.registerFailed')}`, style: 'err' },
            ], 'enter', t('onboarding.terminal.prompt.retry'));
            setPhase('confirm');
        }
    }, [agentName, pushLines, t]);

    /* ═══ Wallet connection (async) ═══ */
    const connectAndOpenWorkspace = useCallback(async (recover = false) => {
        pushLines([
            { text: t('onboarding.terminal.command.connectWallet'), style: 'cmd' },
            { text: t('onboarding.terminal.launchingWallet'), style: 'out' },
        ]);
        setPhase('wallet_connect');

        const connectedAddress = await wallet.connectAccount(recover);

        if (!connectedAddress) {
            // User cancelled or connection failed
            pushLines([
                { text: t('onboarding.terminal.walletCancelled'), style: 'err' },
                { text: '', style: 'out' },
            ], 'enter', t('onboarding.terminal.prompt.retryWallet'));
            setPhase('confirm');
            return;
        }

        // Connected — prepare the personal workspace
        const short = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
        pushLines([
            { text: t('onboarding.terminal.connected', { address: short }), style: 'ok' },
            { text: t('onboarding.terminal.network'), style: 'ok' },
            { text: t('onboarding.terminal.registering'), style: 'out' },
        ]);
        setPhase('register');
        await prepareWorkspace(connectedAddress);
    }, [wallet, pushLines, prepareWorkspace, t]);

    /* ═══ Input handler (wallet-last flow) ═══ */
    const handleSubmit = useCallback(() => {
        const val = input.trim();

        if (phase === 'boot') {
            pushLines([
                { text: '', style: 'out' },
            ], 'text', t('onboarding.terminal.prompt.agentName'));
            setPhase('name');
        } else if (phase === 'name' && val) {
            setAgentName(val);
            setLines(p => [...p, { text: `${t('onboarding.terminal.command.agentName')}"${val}"`, style: 'cmd' }]);
            pushLines([
                { text: t('onboarding.terminal.nameSet', { name: val }), style: 'ok' },
                { text: '', style: 'out' },
                { text: t('onboarding.terminal.command.registerPreview'), style: 'cmd' },
                { text: t('onboarding.terminal.previewName', { name: val }), style: 'out' },
                { text: t('onboarding.terminal.previewMode', { mode: t('onboarding.terminal.valModeHunter') }), style: 'out' },
                { text: t('onboarding.terminal.previewEngine', { engine: t('onboarding.terminal.valEngineV2') }), style: 'out' },
                { text: t('onboarding.terminal.previewTrust', { trust: t('onboarding.trust.reputation') }), style: 'out' },
                { text: '', style: 'out' },
            ], 'enter', t('onboarding.terminal.prompt.register'));
            setPhase('confirm');
        } else if (phase === 'confirm') {
            void connectAndOpenWorkspace();
        } else if (phase === 'done') {
            onComplete?.();
        }
        setInput('');
    }, [phase, input, pushLines, connectAndOpenWorkspace, onComplete, t]);

    /* Global Enter key for 'enter' mode */
    useEffect(() => {
        if (inputMode !== 'enter') return;
        const h = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [inputMode, handleSubmit]);

    const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } };

    /* ═══ Render ═══ */
    return (
        <>
        {phase === 'confirm' && inputMode !== 'none' && <button className="mx-4 mt-2 border border-primary/40 px-3 py-2 font-mono text-xs text-primary" onClick={() => void connectAndOpenWorkspace(true)}>{t('onboarding.recoverPasskey')}</button>}
        <div className="h-full flex flex-col font-mono text-xs cursor-text" onClick={() => inputRef.current?.focus()}>
            <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-px">
                {lines.map((l, i) => (
                    <div key={i} className={`${CLS[l.style]} leading-relaxed whitespace-pre-wrap`}>{l.text || '\u00A0'}</div>
                ))}
                {typing && (
                    <div className={`${CLS[typing.line.style]} leading-relaxed whitespace-pre-wrap`}>
                        {typing.line.text.slice(0, typing.pos)}<span className="animate-pulse">▋</span>
                    </div>
                )}
                {inputMode !== 'none' && !typing && queue.length === 0 && (
                    <div className="flex items-center leading-relaxed mt-0.5">
                        {inputMode === 'enter' ? (
                            <span className="text-muted-foreground/50">{prompt} <span className="animate-pulse">▋</span></span>
                        ) : (
                            <div className="relative flex items-center w-full">
                                <span className="text-foreground shrink-0">{prompt}</span>
                                <span className="text-foreground whitespace-pre">{input}</span>
                                <span className="animate-pulse text-foreground">▋</span>
                                <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                                    className="absolute inset-0 opacity-0 cursor-text w-full" autoFocus />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
        </>
    );
}
