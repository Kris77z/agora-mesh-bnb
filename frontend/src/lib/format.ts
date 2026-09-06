export function formatTokenAmount(
    rawValue: string | number | undefined | null,
    decimals = 18,
    maxFractionDigits = 4,
): string {
    if (rawValue === undefined || rawValue === null || rawValue === '') return '--';
    const raw = String(rawValue);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0) return '--';

    const padded = raw.padStart(decimals + 1, '0');
    const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
    if (decimals === 0 || maxFractionDigits === 0) return whole;
    const fraction = padded
        .slice(-decimals)
        .slice(0, Math.max(0, maxFractionDigits))
        .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

/** Legacy alias for existing native-token views during the UI migration. */
export function formatMON(weiValue: string | number | undefined | null): string {
    return formatTokenAmount(weiValue, 18, 4);
}

/**
 * Shorten a hex address for display.
 * @example shortenAddress('0x1234567890abcdef') => '0x1234…cdef'
 */
export function shortenAddress(addr: string, chars = 4): string {
    if (addr.length <= chars * 2 + 2) return addr;
    return `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}`;
}
