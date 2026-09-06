import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPaidAuditOrder } from './paid-audit-recovery.js';

const input = {missionId: 'mission-a', requestHash: 'hash-a', serviceId: 'audit-a', endpoint: 'http://localhost:3001', payer: 'wallet-a',
  record: {request: {missionId: 'mission-a', requestHash: 'hash-a', serviceId: 'audit-a', idempotencyKey: 'original-key', taskInput: 'original-source'},
    payment: {status: 'payment-completed', payer: 'wallet-a', transaction: 'original-tx'}}};
test('paid audit replay retains original request and idempotency key without payment authorization', async () => {
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), input.record.request);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Idempotency-Key'), 'original-key');
    assert.equal(headers.get('payment-signature'), null);
    assert.equal(headers.get('x-payment'), null);
    assert.equal(headers.get('authorization'), null);
    return Response.json({requestHash: 'hash-a', payment: {transaction: 'original-tx', payer: 'wallet-a'}});
  }) as typeof fetch;
  await replayPaidAuditOrder(input, fetcher);
  assert.equal(calls, 1);
});
test('wrong wallet, mission and unpaid orders are rejected before contacting service', async () => {
  const fetcher = (async () => {throw new Error('must not call service');}) as typeof fetch;
  for (const value of [{...input, payer: 'other'}, {...input, missionId: 'other'}, {...input, record: {...input.record, payment: {...input.record.payment, status: 'pending'}}}]) {
    await assert.rejects(replayPaidAuditOrder(value, fetcher), /does not match/);
  }
});
test('replay cannot replace payment or request binding and never retries failed delivery', async () => {
  for (const response of [{requestHash: 'other', payment: {transaction: 'original-tx', payer: 'wallet-a'}}, {requestHash: 'hash-a', payment: {transaction: 'new-tx', payer: 'wallet-a'}}]) {
    await assert.rejects(replayPaidAuditOrder(input, (async () => Response.json(response)) as typeof fetch), /binding mismatch/);
  }
  let calls = 0;
  await assert.rejects(replayPaidAuditOrder(input, (async () => {calls++; return new Response('', {status: 502});}) as typeof fetch), /original payment is retained/);
  assert.equal(calls, 1);
});
