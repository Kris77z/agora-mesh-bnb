import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Interface, type Provider } from 'ethers';
import { browserAuthorityRouter, managementToken, assertManagementToken, validateBrowserPolicy, assertBrowserStepReceipt, browserCallTargets, assertBrowserCallPermissions, BNB_TESTNET_ORCHESTRATOR } from './browser-authority.js';
import type { PersistedAltanaSession } from './session-codec.js';
import { PERMIT2_ADDRESS } from '@altananetwork/sdk';
import { U_TOKEN } from '@altananetwork/x402-server';
import { browserAuthorityContext } from './browser-context.js';
import { hunterConfig } from '../../config.js';

const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
test('SDK orchestrator permission is required without allowing extra or substituted targets', () => {
  const targets = browserCallTargets([{to: recipient}, {to: PERMIT2_ADDRESS}]);
  assert.deepEqual(targets, [recipient, PERMIT2_ADDRESS.toLowerCase(), BNB_TESTNET_ORCHESTRATOR]);
  assert.equal(browserCallTargets([{to: BNB_TESTNET_ORCHESTRATOR}]).length, 1);
  assert.doesNotThrow(() => assertBrowserCallPermissions(targets, ['a', 'b', 'c'], [true, true, true], false));
  assert.throws(() => assertBrowserCallPermissions(targets, ['a', 'b', 'c', 'd'], [true, true, true], false));
  assert.throws(() => assertBrowserCallPermissions(targets, ['a', 'b', 'c'], [true, true, false], false));
  assert.throws(() => assertBrowserCallPermissions(targets, ['a', 'b', 'c'], [true, true, true], true));
});
test('receipt binding rejects a different wallet, key, operation, spender or allowance', () => {
  const record = {authority: {walletAddress: wallet, spendLimits: [{limit: '1150000000000000000'}]}, session: {expiry: 1800000000}} as unknown as PersistedAltanaSession;
  const hash = `0x${'ab'.repeat(32)}`;
  const abi = new Interface(['event Approval(address indexed owner,address indexed spender,uint256 value)', 'event Revoked(bytes32 indexed keyHash)', 'event SignatureCheckerApprovalSet(bytes32 indexed keyHash,address indexed checker,bool isApproved)']);
  const approval = (owner = wallet, spender = PERMIT2_ADDRESS, amount = 1150000000000000000n) => ({address: U_TOKEN[97].address, ...abi.encodeEventLog(abi.getEvent('Approval')!, [owner, spender, amount])});
  assert.doesNotThrow(() => assertBrowserStepReceipt(record, 'approveAllowance', hash, [approval()]));
  for (const log of [approval(recipient), approval(wallet, recipient), approval(wallet, PERMIT2_ADDRESS, 1n), {...approval(), address: recipient}]) assert.throws(() => assertBrowserStepReceipt(record, 'approveAllowance', hash, [log]));
  assert.throws(() => assertBrowserStepReceipt(record, 'revokeAllowance', hash, [approval()]));
  const revoked = {address: wallet, ...abi.encodeEventLog(abi.getEvent('Revoked')!, [hash])};
  assert.doesNotThrow(() => assertBrowserStepReceipt(record, 'revokeSession', hash, [revoked]));
  assert.throws(() => assertBrowserStepReceipt(record, 'grantSession', hash, [revoked]));
  assert.throws(() => assertBrowserStepReceipt(record, 'revokeSession', `0x${'cd'.repeat(32)}`, [revoked]));
});
test('browser capabilities cannot be reused for another Authority or another server secret', () => {
  const id = 'browser-11111111-1111-4111-8111-111111111111';
  const other = 'browser-22222222-2222-4222-8222-222222222222';
  const token = managementToken(id, 'one');
  assert.doesNotThrow(() => assertManagementToken(id, token, 'one'));
  for (const [target, supplied, secret] of [[other, token, 'one'], [id, token, 'two'], [id, '', 'one'], ['../../file', token, 'one']]) {
    assert.throws(() => assertManagementToken(target, supplied, secret));
  }
});
test('browser policy enforces finite Testnet budget, expiry and explicit recipients', () => {
  const policy = {walletAddress: wallet, limit: '1.15', hours: 1};
  assert.equal(validateBrowserPolicy(policy, [recipient]).limit, '1150000000000000000');
  for (const limit of ['0', '-1', '10.001', '1e3', '0.0001', 'Infinity']) assert.throws(() => validateBrowserPolicy({...policy, limit}, [recipient]));
  for (const hours of [0, 25, NaN, 1.5]) assert.throws(() => validateBrowserPolicy({...policy, hours}, [recipient]));
  assert.throws(() => validateBrowserPolicy(policy, []));
});
test('concurrent task contexts preserve separate paying wallets across async boundaries', async () => {
  const values = await Promise.all(['a', 'b'].map((id) => browserAuthorityContext.run({authorityId: id, walletAddress: id}, async () => {
    await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 10 : 1));
    return browserAuthorityContext.getStore();
  })));
  assert.deepEqual(values.map((v) => v?.authorityId), ['a', 'b']);
  assert.equal(browserAuthorityContext.getStore(), undefined);
});
test('HTTP prepare keeps signer private, rejects wrong capabilities and blocks uncertain transaction replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agora-browser-'));
  const previous = {...hunterConfig.altana};
  const previousRecipients = process.env.ALTANA_X402_ALLOWED_RECIPIENTS;
  const previousBackend = process.env.STORE_BACKEND;
  Object.assign(hunterConfig.altana, {enabled: true, sessionEncryptionKey: 'aa'.repeat(32), sessionStorePath: path.join(dir, 'sessions.json'), authorityEvidencePath: path.join(dir, 'evidence.json')});
  process.env.STORE_BACKEND = 'file';
  process.env.ALTANA_X402_ALLOWED_RECIPIENTS = recipient;
  const app = express(); app.use(express.json());
  app.use(browserAuthorityRouter({getTransactionReceipt: async () => null} as unknown as Provider));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown, token = '') => fetch(base + url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Authority-Token': token}, body: JSON.stringify(body)});
  try {
    const response = await post('/prepare', {walletAddress: wallet, limit: '1.15', hours: 1});
    assert.equal(response.status, 201);
    const payload = await response.json() as {authority: {authorityId: string}; accessToken: string; session: object};
    const raw = JSON.stringify(payload);
    assert.doesNotMatch(raw, /signerPrivateKey|_privateKey|tokenHash/);
    const route = `/${payload.authority.authorityId}`;
    assert.equal((await post(`${route}/runs/11111111-1111-4111-8111-111111111111/recover`, {}, 'bb'.repeat(32))).status, 401);
    assert.equal((await post(`${route}/begin`, {step: 'grantSession'}, 'bb'.repeat(32))).status, 401);
    assert.equal((await post(`${route}/begin`, {step: 'revokeChecker'}, payload.accessToken)).status, 409);
    assert.equal((await post(`${route}/begin`, {step: 'approveAllowance'}, payload.accessToken)).status, 409);
    assert.equal((await post(`${route}/begin`, {step: 'grantSession'}, payload.accessToken)).status, 200);
    assert.equal((await post(`${route}/begin`, {step: 'grantSession'}, payload.accessToken)).status, 409);
    assert.equal((await post(`${route}/confirm`, {transactionHash: `0x${'11'.repeat(32)}`}, payload.accessToken)).status, 409);
    const current = await fetch(base + route, {headers: {'X-Authority-Token': payload.accessToken}}).then((r) => r.json()) as {authority: {status: string}; lifecycle: {pendingStep: string}};
    assert.equal(current.authority.status, 'invalid');
    assert.equal(current.lifecycle.pendingStep, 'grantSession');
    assert.equal((await post(`${route}/check-ungranted`, {}, payload.accessToken)).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    Object.assign(hunterConfig.altana, previous);
    if (previousRecipients === undefined) delete process.env.ALTANA_X402_ALLOWED_RECIPIENTS; else process.env.ALTANA_X402_ALLOWED_RECIPIENTS = previousRecipients;
    if (previousBackend === undefined) delete process.env.STORE_BACKEND; else process.env.STORE_BACKEND = previousBackend;
    await rm(dir, {recursive: true, force: true});
  }
});
