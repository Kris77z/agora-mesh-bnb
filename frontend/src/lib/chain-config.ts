export type PublicChainPresetName = 'bnb-testnet' | 'monad-testnet';

export interface PublicChainConfig {
    preset: PublicChainPresetName;
    id: number;
    token: string;
    label: string;
    rpcUrl: string;
    explorerUrl: string;
    averageBlockTimeLabel: string;
}

const PRESETS: Record<PublicChainPresetName, PublicChainConfig> = {
    'bnb-testnet': {
        preset: 'bnb-testnet',
        id: 97,
        token: 'tBNB',
        label: 'BNB Smart Chain Testnet',
        rpcUrl: 'https://bsc-testnet-dataseed.bnbchain.org',
        explorerUrl: 'https://testnet.bscscan.com',
        averageBlockTimeLabel: '~1.5s',
    },
    'monad-testnet': {
        preset: 'monad-testnet',
        id: 10143,
        token: 'MON',
        label: 'Monad Testnet',
        rpcUrl: 'https://testnet-rpc.monad.xyz',
        explorerUrl: 'https://testnet.monadexplorer.com',
        averageBlockTimeLabel: '~400ms',
    },
};

function resolvePreset(raw: string | undefined): PublicChainPresetName {
    return raw === 'monad-testnet' ? 'monad-testnet' : 'bnb-testnet';
}

const preset = resolvePreset(process.env.NEXT_PUBLIC_CHAIN_PRESET);
const base = PRESETS[preset];
const configuredChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? base.id);

export const publicChainConfig: PublicChainConfig = {
    ...base,
    id: Number.isSafeInteger(configuredChainId) && configuredChainId > 0
        ? configuredChainId
        : base.id,
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL?.trim() || base.rpcUrl,
};

/** Default service settlement asset; native gas uses publicChainConfig.token. */
export const servicePaymentSymbol = preset === 'bnb-testnet' ? 'U' : 'MON';
