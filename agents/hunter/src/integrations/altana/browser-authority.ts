import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { ethers } from 'ethers';
import { BNB_TESTNET, PERMIT2_ADDRESS, createClient, createPrivateKeySigner } from '@altananetwork/sdk';
import { U_TOKEN } from '@altananetwork/x402-server';
import { getProcessPostgresStore, withLocalFileLock, type AuthorityRecord, type HexHash } from '@rebel/shared';
import { HunterRunManager } from '../../run-manager.js';
import { FileHunterRunStore, PostgresHunterRunStore, publicRunRecord, validateRunIdempotencyKey, type HunterRunStore } from '../../run-store.js';
import { FileHunterMissionStore, PostgresHunterMissionStore } from '../../mission-store.js';
import { runHunter } from '../../react-engine.js';
import { browserAuthorityContext } from './browser-context.js';
import { loadActiveAltanaAuthority } from './authority.js';
import { hunterConfig } from '../../config.js';
import { HunterError } from '../../errors.js';
import { createPersistedAltanaSession, restoreAltanaSession, type PersistedAltanaSession } from './session-codec.js';
import { EncryptedAltanaSessionStore } from './session-store.js';
import { openAuthorityEvidenceStore, type AuthorityLifecycleStep } from './authority-evidence-store.js';
import { revokeAuthority } from './authority-lifecycle.js';
import { readAuthoritySpending } from './authority-spending.js';
import { recoverPaidAudit } from '../../paid-audit-recovery.js';

const grantSteps: AuthorityLifecycleStep[] = ['grantSession', 'approveChecker', 'approveAllowance'];
const revokeSteps: AuthorityLifecycleStep[] = ['revokeChecker', 'revokeAllowance', 'revokeSession'];
const token = U_TOKEN[97];
// Altana BNB-testnet relay deployment. Porto Key.toRelay adds this call
// permission to every session (SDK 0.8.0); it is not a service recipient.
export const BNB_TESTNET_ORCHESTRATOR = '0xcb5cef3c54aa90e9a7ad602a258d3d360cc862b9';
export function browserCallTargets(calls: readonly {to?: string}[]): string[] {
  const targets = calls.map((call) => {
    if (!call.to || !ethers.isAddress(call.to)) throw new Error('Explicit call target required.');
    return call.to.toLowerCase();
  });
  return [...new Set([...targets, BNB_TESTNET_ORCHESTRATOR])];
}
export function assertBrowserCallPermissions(targets: readonly string[], packed: readonly string[], checks: readonly boolean[], wildcard: boolean) {
  if (packed.length !== targets.length || checks.length !== targets.length || checks.some((ok) => !ok) || wildcard) throw new Error('Onchain call permissions do not match the exact allowlist.');
}
const events = new ethers.Interface([
  'event Authorized(bytes32 indexed keyHash, tuple(uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey) key)',
  'event Revoked(bytes32 indexed keyHash)',
  'event SignatureCheckerApprovalSet(bytes32 indexed keyHash,address indexed checker,bool isApproved)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);

export function assertBrowserStepReceipt(record: PersistedAltanaSession, step: AuthorityLifecycleStep, hash: string, logs: readonly {address: string; topics: readonly string[]; data: string}[]) {
  const matches = logs.some((log) => {
    const allowance = step === 'approveAllowance' || step === 'revokeAllowance';
    if (log.address.toLowerCase() !== (allowance ? token.address : record.authority.walletAddress).toLowerCase()) return false;
    let parsed;
    try { parsed = events.parseLog({topics: [...log.topics], data: log.data}); } catch { return false; }
    if (!parsed) return false;
    if (allowance) return parsed.name === 'Approval' && parsed.args.owner.toLowerCase() === record.authority.walletAddress.toLowerCase() && parsed.args.spender.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() && parsed.args.value === (step === 'revokeAllowance' ? 0n : BigInt(record.authority.spendLimits[0].limit));
    if (parsed.args.keyHash?.toLowerCase() !== hash.toLowerCase()) return false;
    if (step === 'grantSession') return parsed.name === 'Authorized' && Number(parsed.args.key.expiry) === record.session.expiry && !parsed.args.key.isSuperAdmin && Number(parsed.args.key.keyType) === 2;
    if (step === 'revokeSession') return parsed.name === 'Revoked';
    return parsed.name === 'SignatureCheckerApprovalSet' && parsed.args.checker.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() && parsed.args.isApproved === (step === 'approveChecker');
  });
  if (!matches) throw new Error('Transaction does not contain the expected wallet/session operation.');
}
const accountAbi = [
  'function getKey(bytes32) view returns (tuple(uint40 expiry,uint8 keyType,bool isSuperAdmin,bytes publicKey))',
  'function approvedSignatureCheckers(bytes32) view returns (address[])',
  'function spendInfos(bytes32) view returns (tuple(address token,uint8 period,uint256 limit,uint256 spent,uint256 lastUpdated,uint256 currentSpent,uint256 current)[])',
  'function canExecute(bytes32,address,bytes) view returns (bool)',
  'function canExecutePackedInfos(bytes32) view returns(bytes32[])',
];

export function managementToken(id: string, secret: string): string {
  return createHmac('sha256', secret).update(`agora-browser-authority-v1:${id}`).digest('hex');
}

export function assertManagementToken(id: string, supplied: unknown, secret: string): void {
  if (!/^browser-[0-9a-f-]{36}$/.test(id) || typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(managementToken(id, secret), 'hex'))) {
    throw new HunterError(401, 'AUTHORITY_ACCESS_DENIED', 'This browser does not hold access to this Authority.');
  }
}

export function validateBrowserPolicy(body: { walletAddress?: unknown; limit?: unknown; hours?: unknown }, recipients: string[]) {
  if (typeof body.walletAddress !== 'string' || !ethers.isAddress(body.walletAddress)) throw new Error('A valid Passkey wallet address is required.');
  if (typeof body.limit !== 'string' || !/^\d+(\.\d{1,3})?$/.test(body.limit)) throw new Error('Budget must have at most three decimal places.');
  const limit = ethers.parseUnits(body.limit, token.decimals);
  if (limit <= 0n || limit > ethers.parseUnits('10', token.decimals)) throw new Error('Testnet budget must be greater than zero and at most 10 U.');
  if (typeof body.hours !== 'number' || !Number.isInteger(body.hours) || body.hours < 1 || body.hours > 24) throw new Error('Duration must be 1–24 hours.');
  if (!recipients.length || recipients.some((a) => !ethers.isAddress(a) || a === ethers.ZeroAddress)) throw new Error('Approved service recipients are not configured.');
  return { walletAddress: ethers.getAddress(body.walletAddress), limit: limit.toString(), hours: body.hours,
    recipients: [...new Set(recipients.map((a) => ethers.getAddress(a)))] };
}

export function publicBrowserSession(record: PersistedAltanaSession) {
  return { authority: record.authority, session: record.session };
}

export function browserAuthorityRouter(providerOverride?: ethers.Provider) {
  const router = express.Router();
  const encryptionKey = hunterConfig.altana.sessionEncryptionKey;
  const rpcUrl = process.env.ALTANA_RPC_URL_OVERRIDE?.trim() || hunterConfig.rpcUrl;
  const provider = providerOverride ?? new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true });
  const sessions = () => new EncryptedAltanaSessionStore(hunterConfig.altana.sessionStorePath, encryptionKey!);
  const recipients = () => (process.env.ALTANA_X402_ALLOWED_RECIPIENTS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const managers = new Map<string, Promise<{ manager: HunterRunManager; store: HunterRunStore }>>();
  const recoveries = new Map<string, {status: 'running' | 'completed' | 'failed'; message: string}>();
  const managerFor = (id: string) => {
    let entry = managers.get(id);
    if (!entry) {
      if (managers.size >= 64) throw new HunterError(503, 'CAPACITY_REACHED', 'This demo worker has reached its Authority capacity.');
      entry = (async () => {
        const pg = await getProcessPostgresStore('agora-hunter');
        const store = pg ? new PostgresHunterRunStore(pg, `hunter-${id}`) : new FileHunterRunStore(`${hunterConfig.runStorePath}.${id}.json`);
        const missions = pg ? new PostgresHunterMissionStore(pg) : new FileHunterMissionStore(hunterConfig.missionStorePath);
        const manager = new HunterRunManager(store, async (goal, options, mode) => {
          const record = await loadActiveAltanaAuthority({ authorityId: id, storePath: hunterConfig.altana.sessionStorePath, evidencePath: hunterConfig.altana.authorityEvidencePath, encryptionKey: encryptionKey! });
          return browserAuthorityContext.run({ authorityId: id, walletAddress: record.authority.walletAddress }, () => runHunter(goal, options, mode));
        }, async (run) => {
          await missions.save({ missionId: run.missionId, goal: run.goal, chainId: 97, authorityId: id,
            mode: run.result?.mode ?? 'react', status: run.status === 'completed' ? 'completed' : 'failed', source: 'live-run',
            events: run.events, result: run.result, error: run.error, createdAt: run.createdAt, completedAt: run.updatedAt });
        });
        return { manager, store };
      })();
      managers.set(id, entry);
      void entry.catch(() => managers.delete(id));
    }
    return entry;
  };
  const locked = <T>(operation: () => Promise<T>) => withLocalFileLock(`${hunterConfig.altana.sessionStorePath}.lifecycle`, operation);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!encryptionKey || !hunterConfig.altana.enabled || hunterConfig.chainId !== 97) {
      res.status(503).json({ message: 'BNB Testnet Authority management is not configured.' }); return;
    }
    next();
  });
  const handle = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler => (req, res) => {
    void fn(req, res).catch((error: unknown) => {
      res.status(error instanceof HunterError ? error.status : 409).json({ message: error instanceof HunterError ? error.message : 'The step could not be confirmed. Refresh chain status before retrying; no automatic transaction was sent.' });
    });
  };
  router.get('/config', handle(async (_req, res) => {
    res.json({ chainId: 97, token, recipients: recipients(), maxBudget: '10', maxHours: 24 });
  }));
  router.post('/prepare', handle(async (req, res) => {
    let policy;
    try { policy = validateBrowserPolicy(req.body ?? {}, recipients()); }
    catch (error) { throw new HunterError(400, 'INVALID_POLICY', (error as Error).message); }
    const id = `browser-${randomUUID()}`;
    const signer = createPrivateKeySigner();
    const expiry = Math.floor(Date.now() / 1000) + policy.hours * 3600;
    const authority: AuthorityRecord = {
      authorityId: id, walletAddress: policy.walletAddress as `0x${string}`, sessionPublicKey: signer.publicKey,
      chainId: 97, allowedCalls: policy.recipients.map((to) => ({ to: to as `0x${string}` })),
      spendLimits: [{ asset: { chainId: 97, kind: 'erc20', address: token.address, symbol: token.symbol, decimals: token.decimals }, limit: policy.limit, period: 'day' }],
      expiry, status: 'invalid', createdAt: Date.now(),
    };
    const session = { walletAddress: authority.walletAddress, signer, publicKey: signer.publicKey, expiry,
      permissions: { calls: [{ to: token.address }, { to: PERMIT2_ADDRESS }, ...authority.allowedCalls], spend: [{ token: token.address, period: 'day' as const, limit: BigInt(policy.limit) }] } };
    const record = createPersistedAltanaSession({ authority, session, signerPrivateKey: signer._privateKey });
    await locked(async () => {
      await sessions().save(id, record);
      await (await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath)).save({ authority, lifecycle: { operation: 'provision', phase: 'in-progress', transactions: {} }, updatedAt: Math.floor(Date.now() / 1000) });
    });
    res.status(201).json({ ...publicBrowserSession(record), accessToken: managementToken(id, encryptionKey!) });
  }));
  router.use('/:id', (req, res, next) => {
    try { assertManagementToken(String(req.params.id), req.get('x-authority-token'), encryptionKey!); next(); }
    catch { res.status(401).json({ message: 'Authority access denied. Use the browser that prepared this session.' }); }
  });
  router.get('/:id', handle(async (req, res) => {
    const id = String(req.params.id);
    const [record, evidence] = await Promise.all([sessions().load(id), (await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath)).get(id)]);
    if (!evidence) throw new HunterError(404, 'NOT_FOUND', 'Authority was not found.');
    const spending = await readAuthoritySpending({ authority: evidence.authority, rpcUrl,
      receiptStorePaths: hunterConfig.altana.paymentEvidencePaths, receiptEvidenceOnly: true,
      receiptEvidenceEnd: evidence.authority.status === 'revoked' ? evidence.updatedAt : undefined,
      now: evidence.authority.status === 'revoked' ? evidence.updatedAt : Math.floor(Date.now() / 1000),
      database: await getProcessPostgresStore('agora-hunter') }).catch(() => undefined);
    res.json({ ...(record ? publicBrowserSession(record) : { authority: evidence.authority }), spending, lifecycle: evidence.lifecycle, revocation: evidence.revocation });
  }));
  router.post('/:id/run', handle(async (req, res) => {
    const id = String(req.params.id);
    await loadActiveAltanaAuthority({ authorityId: id, storePath: hunterConfig.altana.sessionStorePath, evidencePath: hunterConfig.altana.authorityEvidencePath, encryptionKey: encryptionKey! });
    if ([...recoveries.entries()].some(([key, job]) => key.startsWith(`${id}:`) && job.status === 'running')) throw new HunterError(409, 'RECOVERY_IN_PROGRESS', 'Wait for the original task recovery to finish.');
    const goal = req.body?.goal;
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 12000) throw new HunterError(400, 'INVALID_GOAL', 'Enter a goal of 1–12000 characters.');
    const mode = req.body?.mode ?? 'single';
    const locale = req.body?.locale ?? 'en-US';
    if (mode !== 'single' && mode !== 'commander') throw new HunterError(400, 'INVALID_MODE', 'Choose single or commander mode.');
    if (locale !== 'en-US' && locale !== 'zh-CN') throw new HunterError(400, 'INVALID_LOCALE', 'Choose en-US or zh-CN.');
    const { manager } = await managerFor(id);
    const result = await manager.submit({ goal: goal.trim(), idempotencyKey: validateRunIdempotencyKey(req.get('idempotency-key')), requestMode: mode, locale });
    res.status(result.admission.kind === 'conflict' ? 409 : 202).json(publicRunRecord(result.admission.record));
  }));
  router.get('/:id/runs/:missionId', handle(async (req, res) => {
    const { store, manager } = await managerFor(String(req.params.id));
    const record = await store.get(String(req.params.missionId));
    if (!record) throw new HunterError(404, 'NOT_FOUND', 'Task was not found for this Authority.');
    const state = await manager.get(record.missionId);
    res.json({ ...publicRunRecord(record), recovery: recoveries.get(`${req.params.id}:${req.params.missionId}`), recoveryRequired: record.status === 'running' && !state.activeHere });
  }));
  router.post('/:id/runs/:missionId/recover', handle(async (req, res) => {
    const id = String(req.params.id), missionId = String(req.params.missionId);
    const {store} = await managerFor(id);
    const run = await store.get(missionId);
    if (!run) throw new HunterError(404, 'NOT_FOUND', 'Task was not found for this Authority.');
    if (run.status === 'completed') { res.json({status: 'completed'}); return; }
    if (run.status !== 'failed') throw new HunterError(409, 'RECOVERY_NOT_READY', 'Wait for this task to finish before recovery.');
    const record = await loadActiveAltanaAuthority({authorityId: id, storePath: hunterConfig.altana.sessionStorePath, evidencePath: hunterConfig.altana.authorityEvidencePath, encryptionKey: encryptionKey!});
    const key = `${id}:${missionId}`;
    if (recoveries.get(key)?.status === 'running') { res.status(202).json(recoveries.get(key)); return; }
    const job = {status: 'running' as 'running' | 'completed' | 'failed', message: 'Checking the original paid order'};
    recoveries.set(key, job);
    void (async () => {
      await browserAuthorityContext.run({authorityId: id, walletAddress: record.authority.walletAddress}, () => recoverPaidAudit(missionId, (stage) => { job.message = stage; }));
      job.status = 'completed'; job.message = 'Original task recovered';
    })().catch(() => {
      job.status = 'failed'; job.message = 'Recovery could not complete. The original payment is retained. Check service availability and Authority expiry before retrying.';
    });
    res.status(202).json(job);
  }));
  router.post('/:id/check-ungranted', handle(async (req, res) => {
    const record = await sessions().load(String(req.params.id));
    const evidence = await (await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath)).get(String(req.params.id));
    if (!record || !evidence?.lifecycle || record.authority.grantTxHash || evidence.authority.grantTxHash ||
        record.authority.status === 'active' || evidence.lifecycle.pendingStep === 'grantSession') {
      throw new HunterError(409, 'GRANT_UNCERTAIN', 'This Authority needs transaction reconciliation before starting another.');
    }
    const session = restoreAltanaSession(record);
    const keyHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [2n, ethers.keccak256(ethers.zeroPadValue(session.signer.address, 32))]));
    const account = new ethers.Contract(record.authority.walletAddress, accountAbi, provider);
    const keystore = new ethers.Contract(BNB_TESTNET.keyStore, ['function isValidKey(address,bytes32) view returns(bool)'], provider);
    if (await keystore.isValidKey(record.authority.walletAddress, ethers.keccak256(session.publicKey))) throw new Error('Session is registered; complete revocation first.');
    let absent = false;
    try { absent = (await account.getKey(keyHash)).publicKey === '0x'; }
    catch (error) { absent = ethers.isError(error, 'CALL_EXCEPTION') && error.data === ethers.id('KeyDoesNotExist()').slice(0, 10); }
    if (!absent) throw new Error('Could not prove that the account key is absent. Reconcile this Authority first.');
    res.json({ungranted: true});
  }));
  router.post('/:id/begin', handle(async (req, res) => {
    await locked(async () => {
      const id = String(req.params.id);
      const record = await sessions().load(id);
      const evidenceStore = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
      const evidence = await evidenceStore.get(id);
      if (!record || !evidence?.lifecycle) throw new Error('Missing session.');
      const step = req.body?.step as AuthorityLifecycleStep;
      const revoking = revokeSteps.includes(step);
      if (revoking && evidence.lifecycle.operation !== 'revoke' && !record.authority.grantTxHash) throw new HunterError(409, 'SESSION_NOT_GRANTED', 'This session has not been confirmed. Complete or reconcile the grant first.');
      if (!grantSteps.includes(step) && !revoking) throw new Error('Invalid step.');
      if (record.authority.status === 'revoked') throw new Error('Already revoked.');
      if (!revoking && evidence.lifecycle.operation === 'revoke') throw new Error('Revocation cannot be reversed.');
      if (revoking && evidence.lifecycle.operation !== 'revoke') {
        record.authority.status = 'invalid';
        await sessions().save(id, record);
        evidence.authority = record.authority;
        evidence.lifecycle = { operation: 'revoke', phase: 'in-progress', transactions: {} };
      }
      const steps = revoking ? revokeSteps : grantSteps;
      if (steps.slice(0, steps.indexOf(step)).some((s) => !evidence.lifecycle!.transactions[s])) throw new Error('Previous steps are incomplete.');
      if (evidence.lifecycle.transactions[step]) throw new HunterError(409, 'STEP_CONFIRMED', 'This step is already confirmed. Refresh status.');
      if (evidence.lifecycle.pendingStep) throw new HunterError(409, 'STEP_UNCERTAIN', 'A transaction may already be pending. Supply its transaction hash to reconcile it before sending another.');
      evidence.lifecycle.pendingStep = step;
      evidence.lifecycle.phase = 'in-progress';
      await evidenceStore.save(evidence);
    });
    res.json({ ready: true });
  }));
  router.post('/:id/confirm', handle(async (req, res) => {
    await locked(async () => {
      const id = String(req.params.id);
      const record = await sessions().load(id);
      const evidenceStore = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
      const evidence = await evidenceStore.get(id);
      if (!record || !evidence?.lifecycle?.pendingStep) throw new Error('No pending step.');
      const txHash = req.body?.transactionHash;
      if (typeof txHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('Invalid transaction hash.');
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) throw new Error('Transaction is not confirmed.');
      if (Object.values(evidence.lifecycle.transactions).includes(txHash as HexHash)) throw new Error('Transaction was already used for a different step.');
      const step = evidence.lifecycle.pendingStep;
      const session = restoreAltanaSession(record);
      const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [2n, ethers.keccak256(ethers.zeroPadValue(session.signer.address, 32))]));
      assertBrowserStepReceipt(record, step, hash, receipt.logs);
      const account = new ethers.Contract(record.authority.walletAddress, accountAbi, provider);
      const erc20 = new ethers.Contract(token.address, ['function allowance(address,address) view returns(uint256)'], provider);
      const keystore = new ethers.Contract(BNB_TESTNET.keyStore, ['function isValidKey(address,bytes32) view returns(bool)'], provider);
      const valid = () => keystore.isValidKey(record.authority.walletAddress, ethers.keccak256(session.publicKey)) as Promise<boolean>;
      const checker = async () => (await account.approvedSignatureCheckers(hash) as string[]).some((a) => a.toLowerCase() === PERMIT2_ADDRESS.toLowerCase());
      const allowance = () => erc20.allowance(record.authority.walletAddress, PERMIT2_ADDRESS) as Promise<bigint>;
      if (step === 'grantSession' || step === 'approveAllowance') {
        const key = await account.getKey(hash);
        if (!await valid() || key.isSuperAdmin || Number(key.expiry) !== session.expiry || Number(key.keyType) !== 2) throw new Error('Session key is not registered with the expected expiry and role.');
        const limits = await account.spendInfos(hash);
        if (limits.length !== 1 || !limits.some((s: {token: string; period: bigint; limit: bigint}) => s.token.toLowerCase() === token.address.toLowerCase() && Number(s.period) === 2 && s.limit === BigInt(record.authority.spendLimits[0].limit))) throw new Error('Onchain spend cap does not match.');
        const allowed = browserCallTargets(record.session.permissions.calls!);
        const [packed, ...checks] = await Promise.all([account.canExecutePackedInfos(hash), ...allowed.map((to) => account.canExecute(hash, to, '0xabcdef01'))]);
        assertBrowserCallPermissions(allowed, packed, checks, await account.canExecute(hash, '0x3232323232323232323232323232323232323232', '0xabcdef01'));
        record.authority.grantTxHash ??= txHash as HexHash;
      }
      if (step === 'approveChecker' && !await checker()) throw new Error('Checker is not approved.');
      if (step === 'approveAllowance' && (!await checker() || await allowance() !== BigInt(record.authority.spendLimits[0].limit))) throw new Error('Allowance is not the exact agreed budget.');
      if (step === 'revokeChecker' && await checker()) throw new Error('Checker is still approved.');
      if (step === 'revokeAllowance' && await allowance() !== 0n) throw new Error('Allowance is not zero.');
      if (step === 'revokeSession' && await valid()) throw new Error('Session is still valid.');
      evidence.lifecycle.transactions[step] = txHash as HexHash;
      delete evidence.lifecycle.pendingStep;
      if (step === 'approveAllowance') { record.authority.status = 'active'; evidence.lifecycle.phase = 'complete'; }
      evidence.authority = record.authority;
      await evidenceStore.save(evidence);
      await sessions().save(id, record);
    });
    res.json({ confirmed: true });
  }));
  router.post('/:id/finish-revoke', handle(async (req, res) => {
    const result = await locked(async () => {
      const id = String(req.params.id);
      const record = await sessions().load(id);
      const evidence = await openAuthorityEvidenceStore(hunterConfig.altana.authorityEvidencePath);
      const stored = await evidence.get(id);
      if (!record || revokeSteps.some((s) => !stored?.lifecycle?.transactions[s])) throw new Error('Revoke steps are incomplete.');
      const session = restoreAltanaSession(record);
      const relayUrl = process.env.ALTANA_RELAY_URL_OVERRIDE?.trim();
      const client = createClient({ chains: [{ ...BNB_TESTNET, publicRpcUrl: rpcUrl, ...(relayUrl ? { relayUrl } : {}) }] });
      const noBroadcast = async (): Promise<never> => { throw new Error('Browser revocation transaction is missing.'); };
      return revokeAuthority({ authorityId: id, sessions: sessions(), evidence, revokeChecker: noBroadcast, revokeAllowance: noBroadcast, revokeSession: noBroadcast,
        negativeTest: (recipient) => client.execute({ session, chainId: 97, calls: [{ to: token.address, value: 0n, data: new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [recipient, 1n]) as `0x${string}` }] }) });
    });
    res.json(result);
  }));
  return Object.assign(router, { shutdown() { for (const entry of managers.values()) void entry.then(({manager}) => manager.shutdown()).catch(() => undefined); provider.destroy(); } });
}
