'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Loader2, Send, Zap } from 'lucide-react';
import { useI18n } from '@/components/i18n/locale-provider';
import type { RunRequestMode } from '@/hooks/use-agent-stream';
import type { LanguageCode } from '@/types/agent';
import { buildPresets, compilePresetGoal, PresetForm, type Preset } from './preset-form';

interface GoalInputProps {
    onRun: (goal: string, mode?: RunRequestMode, locale?: LanguageCode) => void | boolean;
    isLoading?: boolean;
    /** Externally injected goal (e.g. from history) */
    externalGoal?: string;
}

/** Auto-resize textarea to fit content (max 5 rows) */
const MAX_ROWS = 5;
const LINE_HEIGHT = 20; // px per row

export function GoalInput({ onRun, isLoading, externalGoal }: GoalInputProps) {
    const { locale, t } = useI18n();
    const presets = buildPresets(t);
    const [goal, setGoal] = useState('');
    const [commanderMode, setCommanderMode] = useState(true);
    const [activePreset, setActivePreset] = useState<Preset | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const autoResize = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, LINE_HEIGHT * MAX_ROWS)}px`;
    }, []);

    // Sync external goal (e.g. from history)
    useEffect(() => {
        if (externalGoal !== undefined && externalGoal !== goal) {
            setGoal(externalGoal);
            setActivePreset(null);
            setTimeout(autoResize, 0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalGoal]);

    const handleSubmit = () => {
        const trimmed = goal.trim();
        if (trimmed && !isLoading) {
            const expandedPreset = expandPresetCommand(trimmed, presets);
            const accepted = onRun(
                expandedPreset?.goal ?? trimmed,
                expandedPreset?.mode ?? (commanderMode ? 'commander' : 'single'),
                locale
            );
            if (accepted === false) return;
            setGoal('');
            if (textareaRef.current) {
                textareaRef.current.style.height = `${LINE_HEIGHT}px`;
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setGoal(e.target.value);
        autoResize();
    };

    /** Handle preset click: direct-fill if no params, open form if params needed */
    const handlePresetClick = (preset: Preset) => {
        if (preset.params && preset.params.length > 0) {
            // Toggle form: clicking same preset closes it
            setActivePreset((prev) => (prev?.id === preset.id ? null : preset));
        } else {
            // Direct fill — no params needed
            setGoal(preset.goal);
            setActivePreset(null);
            if (preset.commander) setCommanderMode(true);
            setTimeout(autoResize, 0);
        }
    };

    /** Called by PresetForm when user submits with filled params */
    const handlePresetSubmit = (compiledGoal: string, isCommander: boolean) => {
        setGoal(compiledGoal);
        setActivePreset(null);
        if (isCommander) setCommanderMode(true);
        setTimeout(autoResize, 0);
        // Focus textarea so user can review before sending
        textareaRef.current?.focus();
    };

    return (
        <div className="space-y-2">
            {/* Preset commands */}
            <div className="flex flex-wrap gap-2">
                {presets.map((p) => {
                    const needsParams = p.params && p.params.length > 0;
                    const isActive = activePreset?.id === p.id;
                    return (
                        <button
                            key={p.id}
                            onClick={() => handlePresetClick(p)}
                            disabled={isLoading}
                            className={`px-2 py-0.5 text-[11px] border transition-all disabled:opacity-30 cursor-pointer ${isActive
                                    ? 'text-primary border-primary/60 bg-primary/10'
                                    : p.commander
                                        ? 'text-amber-500 border-amber-500/40 hover:text-amber-400 hover:border-amber-400/60'
                                        : 'text-muted-foreground border-border hover:text-primary hover:border-primary/50 hover:text-glow'
                                }`}
                        >
                            {p.label}{needsParams ? ' …' : ''}
                        </button>
                    );
                })}
            </div>
            <p className="text-[10px] text-muted-foreground/70">
                {t('goal.commandHint')}
            </p>

            {/* Inline parameter form (only shown when a preset with params is active) */}
            {activePreset && activePreset.params && (
                <PresetForm
                    preset={activePreset}
                    onSubmit={handlePresetSubmit}
                    onCancel={() => setActivePreset(null)}
                />
            )}

            {/* Commander mode toggle */}
            <div className="flex items-center gap-2">
                <button
                    onClick={() => setCommanderMode(!commanderMode)}
                    disabled={isLoading}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] border transition-all cursor-pointer disabled:opacity-30 ${commanderMode
                        ? 'text-amber-400 border-amber-500/50 bg-amber-500/10'
                        : 'text-muted-foreground/50 border-border hover:text-muted-foreground'
                        }`}
                >
                    <Zap className="w-2.5 h-2.5" />
                    {commanderMode ? t('goal.mode.commander') : t('goal.mode.single')}
                </button>
                {commanderMode && (
                    <span className="text-[10px] text-amber-500/70">{t('goal.mode.commanderHint')}</span>
                )}
            </div>

            {/* Terminal command line (multi-line) */}
            <div className="flex items-end gap-2">
                <span className={`text-sm text-glow shrink-0 pb-0.5 ${commanderMode ? 'text-amber-400' : 'text-primary'}`}>❯</span>
                <textarea
                    ref={textareaRef}
                    placeholder={t('goal.placeholder')}
                    value={goal}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    disabled={isLoading}
                    rows={1}
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 outline-none border-none caret-primary resize-none leading-5"
                    style={{ height: `${LINE_HEIGHT}px` }}
                />
                {isLoading ? (
                    <span className="flex items-center gap-1.5 text-xs text-primary text-glow shrink-0 pb-0.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t('goal.running')}
                    </span>
                ) : (
                    <button
                        onClick={handleSubmit}
                        disabled={!goal.trim()}
                        className="text-muted-foreground hover:text-primary hover:text-glow transition-colors disabled:opacity-30 shrink-0 pb-0.5 cursor-pointer"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
}

function expandPresetCommand(
    rawGoal: string,
    presets: Preset[],
): { goal: string; mode: RunRequestMode } | null {
    const compact = rawGoal.trim();
    if (!compact.startsWith('//')) {
        return null;
    }

    for (const preset of presets) {
        for (const alias of preset.aliases) {
            if (compact === alias) {
                if (preset.params && preset.params.length > 0) {
                    return null;
                }
                return {
                    goal: preset.goal,
                    mode: preset.commander ? 'commander' : 'single',
                };
            }

            if (!compact.startsWith(`${alias} `)) {
                continue;
            }

            const remainder = compact.slice(alias.length).trim();
            if (!remainder || !preset.params || preset.params.length !== 1) {
                continue;
            }

            const [param] = preset.params;
            return {
                goal: compilePresetGoal(preset, { [param.key]: remainder }),
                mode: preset.commander ? 'commander' : 'single',
            };
        }
    }

    return null;
}
