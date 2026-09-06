'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { PasskeyCredential, Session, Signer } from '@altananetwork/sdk';
import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';
import { apiBase, demoApiToken } from '@/lib/api-config';
import { formatTokenAmount } from '@/lib/format';

type WalletHandle = { version: 1; address: `0x${string}`; credential: PasskeyCredential };
type Access = { id: string; token: string; missionId?: string; requestKey?: string; requestGoal?: string };
type Step = 'grantSession' | 'approveChecker' | 'approveAllowance' | 'revokeChecker' | 'revokeAllowance' | 'revokeSession';
type Snapshot = {
  authority: { grantTxHash?: string; authorityId: string; walletAddress: `0x${string}`; status: string; expiry: number; allowedCalls: {to: string}[]; spendLimits: {limit: string; asset: {symbol: string; decimals: number}}[] };
  session?: { walletAddress: `0x${string}`; publicKey: `0x${string}`; expiry: number; permissions: {calls: {to: `0x${string}`}[]; spend: {token: `0x${string}`; period: 'day'; limit: string}[]} };
  lifecycle?: { operation: 'provision' | 'revoke'; pendingStep?: Step; transactions: Partial<Record<Step, string>> };
  spending?: {spent: string; remaining: string; transactions: {txHash: string; amount: string}[]}[];
  revocation?: {negativeTest?: {rejected: boolean}; sessionMaterialDeleted: boolean};
};
type Run = { missionId: string; status: string; recoveryRequired?: boolean; recovery?: {status: string; message: string}; error?: {code?: string; message: string}; events: {type: string; at: string}[]; result?: {finalMessage: string; paymentTx: string; verification?: {paymentTx: string}} };
const walletStorage = 'agora.passkey-wallet.v1';
const accessStorage = 'agora.passkey-authority.v1';
const labels: Record<Step, string> = {
  grantSession: 'Grant bounded session', approveChecker: 'Allow service payment signatures', approveAllowance: 'Approve exact U budget',
  revokeChecker: 'Disable payment signatures', revokeAllowance: 'Clear remaining U allowance', revokeSession: 'Revoke session in Keystore',
};
const grantSteps: Step[] = ['grantSession', 'approveChecker', 'approveAllowance'];
const revokeSteps: Step[] = ['revokeChecker', 'revokeAllowance', 'revokeSession'];
const button = 'rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-40';
const input = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';

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

export default function ManageAuthorityPage() {
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
  const running = useRef(false);
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
        if (rawWallet) { const stored = JSON.parse(rawWallet) as WalletHandle; if (stored.version === 1 && stored.credential.kind === 'webauthn') setWallet(stored); }
        const rawAccess = sessionStorage.getItem(accessStorage);
        if (rawAccess) { const stored = JSON.parse(rawAccess) as Access; setAccess(stored); const s = await api<Snapshot>(`/${stored.id}`, stored); if (!cancelled) setSnapshot(s); }
        const c = await api<{ token: {address: `0x${string}`}; recipients: string[] }>('/config');
        if (!cancelled) setConfig(c);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load wallet.'); }
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
        setRun(result);
        if (result.status !== 'running') { const latest = await api<Snapshot>(`/${access.id}`, access); if (!cancelled) setSnapshot(latest); }
        if ((result.status === 'running' && !result.recoveryRequired) || result.recovery?.status === 'running') timer = setTimeout(poll, 2500);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Task status unavailable.'); }
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
    if (!window.isSecureContext || !window.PublicKeyCredential) throw new Error('Passkeys require HTTPS or localhost and a compatible browser.');
    const sdk = await import('@altananetwork/sdk');
    const client = sdk.createClient({chains: [{...sdk.BNB_TESTNET, relayUrl: `${window.location.origin}/api/altana/relay`, publicRpcUrl: `${window.location.origin}/api/altana/rpc`}]});
    const result = recover ? await client.recoverFromPasskey({chainId: 97}) : await client.createPasskeyWallet({name: 'Agora Mesh'});
    if (result.signer.credential.kind !== 'webauthn') throw new Error('A device Passkey is required.');
    const handle: WalletHandle = {version: 1, address: result.address, credential: result.signer.credential};
    localStorage.setItem(walletStorage, JSON.stringify(handle)); setWallet(handle);
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
  const active = snapshot?.authority.status === 'active' && snapshot.authority.expiry * 1000 > Date.now();
  return <MarketplaceShell><main className="mx-auto max-w-5xl space-y-6 px-5 py-12 sm:px-8">
    <div><p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">BNB Testnet · Passkey wallet</p><h1 className="mt-3 font-heading text-4xl font-semibold">Give Hunter a goal and a boundary.</h1><p className="mt-4 text-muted-foreground">Your device approves the budget. Hunter pays specialist agents within it.</p></div>
    <section className="rounded-2xl border border-border p-6"><h2 className="text-xl font-semibold">1. Your wallet</h2>
      {wallet ? <><p className="mt-3 break-all font-mono text-sm">{wallet.address}</p><p className="mt-2 text-sm text-muted-foreground">Fund this wallet with testnet BNB for fees and testnet U for services.</p><div className="mt-4 flex flex-wrap gap-3"><button className={button} disabled={!!busy} onClick={() => void perform('Checking balances', async () => { const {client, wallet: w} = await sdkWallet(); const b = await client.balances({wallet: w, chainId: 97, tokens: config ? [config.token.address] : []}); const {formatEther, formatUnits} = await import('ethers'); setBalances(`${formatEther(b.native)} tBNB · ${b.tokens?.[0]?.ok ? formatUnits(b.tokens[0].raw, 18) : 'unavailable'} U`); })}>Check balance</button><a className="px-2 py-2 text-sm underline" href={`https://testnet.altana.network/account/${wallet.address}`} target="_blank" rel="noreferrer">Altana Explorer</a><a className="px-2 py-2 text-sm underline" href="https://testnet.bnbchain.org/faucet-smart" target="_blank" rel="noreferrer">Testnet faucet</a></div><p className="mt-3 font-mono text-sm">{balances}</p></> : <div className="mt-4 flex gap-3"><button className={button} disabled={!!busy} onClick={() => void perform('Creating Passkey wallet', () => connect(false))}>Create Passkey wallet</button><button className={button} disabled={!!busy} onClick={() => void perform('Recovering wallet', () => connect(true))}>Recover with Passkey</button></div>}
    </section>
    {snapshot?.authority.status === 'invalid' && !snapshot.authority.grantTxHash && <section className="rounded-2xl border border-border p-6"><h2 className="text-xl font-semibold">Unfinished Authority</h2><p className="mt-3 text-sm">Check whether this session was never registered before setting up another. Existing evidence is retained.</p><button className={`${button} mt-4`} disabled={!!busy} onClick={() => void perform('Checking unregistered session', async () => { await api(`/${access!.id}/check-ungranted`, access, {}); sessionStorage.removeItem(accessStorage); setAccess(undefined); setSnapshot(undefined); setRun(undefined); setReconcileHash(''); setHours(2); })}>Check unregistered session and start again</button></section>}
    {snapshot?.authority.status === 'revoked' && <section className="rounded-2xl border border-border p-6"><h2 className="text-xl font-semibold">Ready for a new task</h2><p className="mt-3 text-sm">This Authority is revoked. Start a new bounded session with this Passkey wallet. Previous reports remain available.</p><button className={`${button} mt-4`} disabled={!!busy} onClick={() => { sessionStorage.removeItem(accessStorage); setAccess(undefined); setSnapshot(undefined); setRun(undefined); setReconcileHash(''); setError(''); setHours(2); }}>Set up a new Authority</button></section>}
    <section className="rounded-2xl border border-border p-6"><h2 className="text-xl font-semibold">2. Set permissions</h2>
      {!snapshot ? <><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm">Budget (testnet U)<input className={`${input} mt-2`} value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" /></label><label className="text-sm">Duration (hours)<input className={`${input} mt-2`} value={hours} type="number" min={1} max={24} onChange={(e) => setHours(Number(e.target.value))}/></label></div><p className="mt-4 text-sm text-muted-foreground">Only these service recipients will be allowed:</p><ul className="mt-2 space-y-1 break-all font-mono text-xs">{config?.recipients.map((a) => <li key={a}>{a}</li>)}</ul><button className={`${button} mt-5`} disabled={!!busy || !wallet || !config?.recipients.length} onClick={() => void perform('Preparing session', async () => { const result = await api<Snapshot & {accessToken: string}>('/prepare', undefined, {walletAddress: wallet!.address, limit: budget, hours}); const a = {id: result.authority.authorityId, token: result.accessToken}; saveAccess(a); setSnapshot(result); await refresh(a); })}>Prepare bounded session</button></> : <><p className="mt-3 text-sm">Status: <strong>{snapshot.authority.status}</strong> · Expires {new Date(snapshot.authority.expiry * 1000).toLocaleString()}</p><p className="mt-2 font-mono text-sm">Budget: {formatTokenAmount(snapshot.authority.spendLimits[0].limit, 18, 3)} U · Confirmed spend: {snapshot.spending?.[0] ? formatTokenAmount(snapshot.spending[0].spent, 18, 3) : 'unavailable'} U</p><p className="mt-2 text-sm">The exact budget is approved once. Each step below requires your device confirmation.</p><ol className="mt-5 space-y-3">{steps.map((step) => <li key={step} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-secondary p-3 text-sm"><span>{snapshot.lifecycle?.transactions[step] ? '✓ ' : ''}{labels[step]}</span>{snapshot.lifecycle?.transactions[step] ? <a href={`https://testnet.bscscan.com/tx/${snapshot.lifecycle.transactions[step]}`} target="_blank" rel="noreferrer" className="underline">Transaction</a> : <button className={button} disabled={!!busy || step !== nextStep || !!pending} onClick={() => void perform(labels[step], () => executeStep(step))}>Confirm on device</button>}</li>)}</ol>
        {pending && <div className="mt-4 rounded-lg border border-amber-600/30 p-4"><p className="text-sm">{labels[pending]} is awaiting confirmation. Paste the transaction hash to check its onchain state before sending another transaction.</p><input aria-label="Transaction hash" className={`${input} mt-3`} placeholder="0x…" value={reconcileHash} onChange={(e) => setReconcileHash(e.target.value)} /><button className={`${button} mt-3`} disabled={!!busy} onClick={() => void perform('Checking transaction', async () => { await api(`/${access!.id}/confirm`, access, {transactionHash: reconcileHash || sessionStorage.getItem(`agora.pending-tx.${access!.id}`)}); await refresh(); })}>Verify transaction</button></div>}
        <button className="mt-4 text-sm underline" disabled={!!busy} onClick={() => void perform('Refreshing Authority', () => refresh())}>Refresh status</button>
      </>}
    </section>
    <section className="rounded-2xl border border-border p-6"><h2 className="text-xl font-semibold">3. Hire agents through Hunter</h2><p className="mt-3 text-sm text-muted-foreground">Describe a Solidity audit or token-risk investigation. Hunter will choose, pay, and verify services using this wallet.</p><textarea aria-label="Task goal" className={`${input} mt-4 min-h-28`} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Audit this BSC contract: 0x…"/><button className={`${button} mt-3`} disabled={!!busy || !active || !goal.trim() || run?.status === 'running' || run?.recovery?.status === 'running'} onClick={() => void perform('Starting task', async () => { const a = {...access!, requestKey: access?.requestKey && access.requestGoal === goal ? access.requestKey : crypto.randomUUID(), requestGoal: goal}; saveAccess(a); const result = await api<Run>(`/${a.id}/run`, a, {goal}, a.requestKey); setRun(result); saveAccess({...a, missionId: result.missionId}); })}>Start bounded task</button>
      {run && <div className="mt-5 rounded-xl bg-secondary p-4"><p className="text-sm font-medium">Task {run.status}</p>{run.recoveryRequired && <p className="mt-2 text-sm">Execution was interrupted. The paid task will not be automatically repeated; its evidence needs reconciliation.</p>}{run.error && <p className="mt-2 text-sm text-destructive">{run.error.message}</p>}<ol className="mt-3 max-h-52 overflow-auto font-mono text-xs">{run.events.map((event, i) => <li key={i} className="py-1">{event.type.replaceAll('_', ' ')}</li>)}</ol>{run.result && <><p className="mt-4 whitespace-pre-wrap text-sm">{run.result.finalMessage}</p><Link className="mt-3 inline-block text-sm underline" href={`/tasks/${run.missionId}`}>Full report and payment evidence</Link></>}</div>}
    </section>
    {run?.status === 'failed' && <section className="rounded-2xl border border-amber-600/30 p-6"><h2 className="text-xl font-semibold">Recover this task</h2><p className="mt-3 text-sm">Recover the original paid audit without paying the Auditor again. Independent verification may use the remaining approved budget.</p>{run.recovery && <p role="status" className="mt-3 text-sm">{run.recovery.message}</p>}<button className={`${button} mt-4`} disabled={!!busy || !active || run.recovery?.status === 'running' || !run.error?.code?.startsWith('X402_')} onClick={() => void perform('Starting task recovery', async () => { await api(`/${access!.id}/runs/${run.missionId}/recover`, access, {}); setRun({...run, recovery: {status: 'running', message: 'Checking original payment'}}); setAccess({...access!}); })}>{run.recovery?.status === 'running' ? 'Recovery in progress' : 'Recover original paid task'}</button>{!active && <p className="mt-3 text-sm">Recovery needs an active Authority. This Authority has expired or been revoked.</p>}</section>}
    {snapshot && snapshot.authority.status !== 'revoked' && <section className="rounded-2xl border border-destructive/30 p-6"><h2 className="text-xl font-semibold">Stop Hunter spending</h2><p className="mt-3 text-sm">Revoke payment signatures, clear the U allowance, then revoke the session. Hunter is disabled locally before the first step.</p>{!revoking ? <button className={`${button} mt-4`} disabled={!!busy} onClick={() => void perform('Revoking payment signatures', () => executeStep('revokeChecker'))}>Start revocation</button> : !nextStep && <button className={`${button} mt-4`} disabled={!!busy} onClick={() => void perform('Verifying revoked key', async () => { await api(`/${access!.id}/finish-revoke`, access, {}); await refresh(); })}>Verify rejection and delete session key</button>}</section>}
    {snapshot?.revocation?.negativeTest?.rejected && <div className="rounded-xl border border-emerald-700/30 p-5 text-sm"><p>Revoked Session payment was rejected. Session key deleted: {snapshot.revocation.sessionMaterialDeleted ? 'yes' : 'no'}.</p><button className={`${button} mt-4`} onClick={() => {sessionStorage.removeItem(accessStorage); setAccess(undefined); setSnapshot(undefined); setRun(undefined); setGoal('');}}>Prepare another bounded Authority</button></div>}
    <div role="status" aria-live="polite" className="text-sm">{busy && <p>{busy}…</p>}{error && <p className="rounded-xl border border-destructive/30 p-4 text-destructive">{error}</p>}</div>
    <Link className="text-sm underline" href="/authority">Inspect historical Authority evidence</Link>
  </main></MarketplaceShell>;
}
