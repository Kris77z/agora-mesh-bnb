import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-run wallet selection; never mutate the process-wide demo configuration. */
export const browserAuthorityContext = new AsyncLocalStorage<{ authorityId: string; walletAddress: string }>();
