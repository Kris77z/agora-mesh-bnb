import Onboard from '@web3-onboard/core';
import injectedModule from '@web3-onboard/injected-wallets';
import walletConnectModule from '@web3-onboard/walletconnect';
import { publicChainConfig } from '@/lib/chain-config';

const injected = injectedModule();
const wallets = [injected];
const walletConnectProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim();

// WalletConnect validates projectId during module initialization. Omit the
// optional connector when no id is configured so production prerendering and
// injected wallets continue to work without a WalletConnect account.
if (walletConnectProjectId) {
    wallets.push(walletConnectModule({
        projectId: walletConnectProjectId,
        requiredChains: [publicChainConfig.id],
        dappUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    }));
}

/**
 * Single onboard instance shared across the app.
 * Call `onboard.connectWallet()` to trigger the modal.
 */
export const onboard = Onboard({
    wallets,
    chains: [publicChainConfig],
    appMetadata: {
        name: 'Agora Mesh',
        description: 'Autonomous Agent Economy on BNB',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#2B180A"/><text x="16" y="22" text-anchor="middle" fill="#FCF6EF" font-size="16" font-weight="bold">A</text></svg>',
    },
    connect: {
        autoConnectLastWallet: true,
    },
    accountCenter: {
        desktop: { enabled: false },
        mobile: { enabled: false },
    },
});
