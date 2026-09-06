import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardAltanaRpc, transportAttempts, PreSendTransportError } from './altana-rpc-transport';

test('read transport falls back after network failure', async () => {
  const urls: string[] = [];
  const result = await forwardAltanaRpc('rpc', '{}', ['eth_getBalance'], async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error('TLS failure');
    return {jsonrpc: '2.0', id: 1, result: '0x1'};
  });
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  assert.deepEqual(result, {jsonrpc: '2.0', id: 1, result: '0x1'});
});
test('signed and mixed requests never retry even if the response is lost', async () => {
  for (const methods of [['wallet_sendPreparedCalls'], ['wallet_getCapabilities', 'wallet_sendPreparedCalls'], ['wallet_upgradeAccount'], ['wallet_prepareCalls', 'wallet_sendPreparedCalls']]) {
    let calls = 0;
    await assert.rejects(forwardAltanaRpc('relay', '{}', methods, async () => { calls++; throw new Error('Lost response'); }));
    assert.equal(calls, 1);
  }
  assert.equal(transportAttempts('relay', ['wallet_getCapabilities']).length, 3);
});
test('unsigned preparation can recover without changing or submitting its body', async () => {
  let calls = 0;
  const body = JSON.stringify({jsonrpc: '2.0', method: 'wallet_prepareCalls', params: []});
  const result = await forwardAltanaRpc('relay', body, ['wallet_prepareCalls'], async (_url, sent) => {
    assert.equal(sent, body);
    if (++calls === 1) throw new Error('TLS failure');
    return {jsonrpc: '2.0', result: {digest: 'prepared-only'}};
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, {jsonrpc: '2.0', result: {digest: 'prepared-only'}});
});
test('RPC application errors are returned without transport replay', async () => {
  let calls = 0;
  const result = await forwardAltanaRpc('rpc', '{}', ['eth_call'], async () => { calls++; return {jsonrpc: '2.0', id: 1, error: {code: -32000, message: 'execution reverted'}}; });
  assert.equal(calls, 1);
  assert.ok((result as {error: unknown}).error);
});
test('signed submission reconnects only after a proven pre-send connection failure', async () => {
  let calls = 0;
  const body = 'unchanged signed payload';
  const result = await forwardAltanaRpc('relay', body, ['wallet_sendPreparedCalls'], async (_url, sent) => {
    assert.equal(sent, body);
    if (++calls === 1) throw new PreSendTransportError('TLS handshake failed');
    return {jsonrpc: '2.0', result: 'accepted'};
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, {jsonrpc: '2.0', result: 'accepted'});
  calls = 0;
  await assert.rejects(forwardAltanaRpc('relay', body, ['wallet_sendPreparedCalls'], async () => {
    if (++calls === 1) throw new PreSendTransportError('DNS failure');
    throw new Error('Response lost after sending');
  }));
  assert.equal(calls, 2);
});
