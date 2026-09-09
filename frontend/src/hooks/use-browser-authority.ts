'use client';

import { useEffect, useRef, useState } from 'react';
import type { PasskeyCredential, Session, Signer } from '@altananetwork/sdk';
import { prepareBoundedSubmission, isAuthorityReady, type AuthorityAccess } from '@/lib/bounded-submission';
import { apiBase, demoApiToken } from '@/lib/api-config';

type WalletHandle = { version: 1; address: `0x${string}`; credential: PasskeyCredential };
type Access = AuthorityAccess;
type Step = 'grantSession' | 'approveChecker' | 'approveAllowance' | 'revokeChecker' | 'revokeAllowance' | 'revokeSession';
type Snapshot = {
  authority: { grantTxHash?: string; authorityId: string; walletAddress: `0x${string}`; status: string; expiry: number; allowedCalls: {to: string}[]; spendLimits: {limit: string; asset: {symbol: string; decimals: number}}[] };
  session?: { walletAddress: `0x${string}`; publicKey: `0x${string}`; expiry: number; permissions: {calls: {to: `0x${string}`}[]; spend: {token: `0x${string}`; period: 'day'; limit: string}[]} };
  lifecycle?: { operation: 'provision' | 'revoke'; pendingStep?: Step; transactions: Partial<Record<Step, string>> };
  spending?: {spent: string; remaining: string; transactions: {txHash: string; amount: string}[]}[];
  revocation?: {negativeTest?: {rejected: boolean}; sessionMaterialDeleted: boolean};
};
export type Run = { missionId: string; status: string; recoveryRequired?: boolean; recovery?: {status: string; message: string}; error?: {code?: string; message: string}; events: AgentEvent[]; result?: HunterRunResult };
const walletStorage = 'agora.passkey-wallet.v1';
const accessStorage = 'agora.passkey-authority.v1';
/** i18n keys, not display strings — callers resolve them through t(). */
const labels: Record<Step, string> = {
  grantSession: 'authority.step.grantSession', approveChecker: 'authority.step.approveChecker', approveAllowance: 'authority.step.approveAllowance',
  revokeChecker: 'authority.step.revokeChecker', revokeAllowance: 'authority.step.revokeAllowance', revokeSession: 'authority.step.revokeSession',
};
const grantSteps: Step[] = ['grantSession', 'approveChecker', 'approveAllowance'];
const revokeSteps: Step[] = ['revokeChecker', 'revokeAllowance', 'revokeSession'];
async function api<T>(path: string, access?: Access, body?: unknown, requestKey?: string): Promise<T> {
  const response = await fetch(`${apiBase.hunter}/browser-authority${path}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(demoApiToken ? {Authorization: `Bearer ${demoApiToken}`} : {}), ...(access ? {'X-Authority-Token': access.token} : {}), ...(requestKey ? {'Idempotency-Key': requestKey} : {}) },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error?.message ?? `Request failed (${response.status})`);
  return result as T;
}

import type { AgentEvent, HunterRunResult, RunRequestMode, LanguageCode } from '@/types/agent';
import { connectPasskeyWallet, readPasskeyWallet, passkeyWalletEvent } from '@/lib/passkey-wallet';
export function useBrowserAuthority() {
  const [wallet, setWallet] = useState<WalletHandle>();
  const [access, setAccess] = useState<Access>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [config, setConfig] = useState<{ token: {address: `0x${string}`}; recipients: string[] }>();
  const [budget, setBudget] = useState('1.15');
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reconcileHash, setReconcileHash] = useState('');
  const [balances, setBalances] = useState('');
  const [goal, setGoal] = useState('');
  const [run, setRun] = useState<Run>();
  const [loaded, setLoaded] = useState(false);
  const running = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer=setInterval(() => setNow(Date.now()), 1000); const sync=()=>setWallet(readPasskeyWallet()); window.addEventListener(passkeyWalletEvent,sync); return()=>{clearInterval(timer);window.removeEventListener(passkeyWalletEvent,sync)}; }, []);
  function saveAccess(value: Access) { sessionStorage.setItem(accessStorage, JSON.stringify(value)); setAccess(value); }
  async function refresh(current = access) {
    if (current) setSnapshot(await api<Snapshot>(`/${current.id}`, current));
  }
  async function perform(label: string, fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Operation failed.'); }
    finally { running.current = false; setBusy(''); }
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rawWallet = localStorage.getItem(walletStorage);
        if (rawWallet) setWallet(readPasskeyWallet());
        const c = await api<{ token: {address: `0x${string}`}; recipients: string[] }>('/config');
        if (!cancelled) setConfig(c);
        const rawAccess = sessionStorage.getItem(accessStorage);
        if (rawAccess) { const stored = JSON.parse(rawAccess) as Access; if (!cancelled) setAccess(stored); const s = await api<Snapshot>(`/${stored.id}`, stored); if (!cancelled) setSnapshot(s); }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load wallet.'); }
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!access?.missionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<Run>(`/${access.id}/runs/${access.missionId}`, access);
        if (cancelled) return;
        setRun(result); setError('');
        if (result.status !== 'running') { const latest = await api<Snapshot>(`/${access.id}`, access); if (!cancelled) setSnapshot(latest); }
        if ((result.status === 'running' && !result.recoveryRequired) || result.recovery?.status === 'running') timer = setTimeout(poll, 2500);
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Task status unavailable.'); timer = setTimeout(poll, 5000); } }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [access]);
  async function sdkWallet() {
    if (!wallet || wallet.credential.kind !== 'webauthn') throw new Error('Create or recover your Passkey wallet first.');
    const sdk = await import('@altananetwork/sdk');
    const client = sdk.createClient({chains: [{...sdk.BNB_TESTNET, relayUrl: `${window.location.origin}/api/altana/relay`, publicRpcUrl: `${window.location.origin}/api/altana/rpc`}]});
    const signer = sdk.signerFromPasskey(wallet.credential);
    return {sdk, client, signer, wallet: {address: wallet.address}};
  }
  async function connect(recover: boolean) {
    setWallet(await connectPasskeyWallet(recover));
  }
  function getSession(): Session {
    const value = snapshot?.session;
    if (!value) throw new Error('Session details are unavailable.');
    // Admin operations only need the session public descriptor; the Session private key remains on the server.
    const signer: Signer = {type: 'privateKey', address: '0x0000000000000000000000000000000000000000', publicKey: value.publicKey, signDigest: async () => { throw new Error('Session signing is server-only.'); }};
    return {...value, signer, permissions: {...value.permissions, spend: value.permissions.spend.map((s) => ({...s, limit: BigInt(s.limit)}))}};
  }
  async function executeStep(step: Step) {
    if (!access || !snapshot?.session || !config) return;
    if (wallet?.address.toLowerCase() !== snapshot.authority.walletAddress.toLowerCase()) throw new Error('Recover the Passkey for this Authority wallet.');
    const {sdk, client, signer, wallet: activeWallet} = await sdkWallet();
    const session = getSession();
    // Derive the secp256k1 session address from its public key for the SDK checker hash.
    const {computeAddress} = await import('ethers');
    session.signer.address = computeAddress(session.publicKey) as `0x${string}`;
    if (step === 'grantSession') {
      const funds = await client.balances({wallet: activeWallet, chainId: 97, tokens: [config.token.address]});
      if (funds.native === BigInt(0) || !funds.tokens?.[0]?.ok || funds.tokens[0].raw < BigInt(snapshot.authority.spendLimits[0].limit)) throw new Error('Fund this Passkey wallet with testnet BNB and at least the agreed U budget before granting.');
    }
    const probe = await fetch('/api/altana/relay', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'wallet_getCapabilities', params: [[97]]})});
    const capabilities = await probe.json();
    if (!probe.ok || !capabilities.result?.['0x61']) throw new Error('Altana connection is unavailable. No transaction was started; try again shortly.');
    await api(`/${access.id}/begin`, access, {step});
    await refresh();
    const base = {wallet: activeWallet, signer, chainId: 97};
    const result = step === 'grantSession' ? await client.grantSession({...base, sessionSigner: session.signer, permissions: session.permissions, expiry: session.expiry, register: true})
      : step === 'approveChecker' ? await client.approveSignatureChecker({...base, session, checker: sdk.PERMIT2_ADDRESS})
      : step === 'approveAllowance' ? await client.approveTokenForPermit2({...base, token: config.token.address, amount: BigInt(snapshot.authority.spendLimits[0].limit)})
      : step === 'revokeChecker' ? await client.revokeSignatureChecker({...base, session, checker: sdk.PERMIT2_ADDRESS})
      : step === 'revokeAllowance' ? await client.approveTokenForPermit2({...base, token: config.token.address, amount: BigInt(0)})
      : await client.revokeSession({...base, session});
    if (!result.transactionHash) throw new Error('Transaction outcome is uncertain. Reconcile its transaction hash before continuing.');
    setReconcileHash(result.transactionHash);
    sessionStorage.setItem(`agora.pending-tx.${access.id}`, result.transactionHash);
    await api(`/${access.id}/confirm`, access, {transactionHash: result.transactionHash});
    setReconcileHash(''); sessionStorage.removeItem(`agora.pending-tx.${access.id}`); await refresh();
  }
  const revoking = snapshot?.lifecycle?.operation === 'revoke';
  const steps = revoking ? revokeSteps : grantSteps;
  const nextStep = steps.find((s) => !snapshot?.lifecycle?.transactions[s]);
  const pending = snapshot?.lifecycle?.pendingStep;
  const active = loaded && isAuthorityReady(snapshot, wallet?.address, now);
  async function startRun(taskGoal: string, mode: RunRequestMode = 'single', locale: LanguageCode = 'en-US') {
    if (!active || !access) { setError('Set up your wallet budget before starting a task.'); return; }
    if (running.current || run?.status === 'running' || run?.recovery?.status === 'running') return;
    await perform('Starting task', async () => {
      const requestGoal = taskGoal.trim();
      if (!requestGoal) return;
      const a = prepareBoundedSubmission(access, requestGoal, mode, locale, () => crypto.randomUUID());
      saveAccess(a); setRun(undefined);
      const result = await api<Run>(`/${a.id}/run`, a, {goal: requestGoal, mode, locale}, a.requestKey);
      setRun(result); saveAccess({...a, missionId: result.missionId});
    });
  }
  return {wallet, setWallet, access, setAccess, snapshot, setSnapshot, config, budget, setBudget, hours, setHours, busy, error, setError, reconcileHash, setReconcileHash, balances, setBalances, goal, setGoal, run, setRun, saveAccess, refresh, perform, sdkWallet, connect, executeStep, revoking, steps, nextStep, pending, active, loaded, startRun};
}
export type BrowserAuthorityController = ReturnType<typeof useBrowserAuthority>;
export { api as authorityApi, accessStorage, labels };
