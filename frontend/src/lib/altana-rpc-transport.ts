import { spawn } from 'node:child_process';

const rpcNodes = ['https://bsc-testnet-rpc.publicnode.com/', 'https://bsc-testnet-dataseed.bnbchain.org/'];
const relayReads = new Set(['wallet_getCapabilities', 'wallet_getAssets', 'wallet_getAuthorization', 'wallet_getCallsHistory', 'wallet_getCallsStatus', 'wallet_getKeys']);
// SDK submitCalls awaits prepareCalls before signCalls and sendPreparedCalls.
// Repeating this unsigned simulation cannot authorize or submit a transaction.
relayReads.add('wallet_prepareCalls');
export class PreSendTransportError extends Error {}

export function transportAttempts(target: 'rpc' | 'relay', methods: string[]): string[] {
  if (target === 'rpc') return [rpcNodes[0], rpcNodes[1], rpcNodes[0]];
  const relay = 'https://testnet-relay.altana.network/';
  return methods.length > 0 && methods.every((method) => relayReads.has(method)) ? [relay, relay, relay] : [relay];
}

export async function forwardAltanaRpc(target: 'rpc' | 'relay', body: string, methods: string[], send = curlJson): Promise<unknown> {
  const attempts = transportAttempts(target, methods);
  const maximum = Math.max(attempts.length, 3);
  for (let index = 0; index < maximum; index++) {
    try { return await send(attempts[index] ?? attempts[0], body, methods.includes('wallet_prepareCalls') ? 30 : attempts.length > 1 ? 12 : 60); }
    catch (error) {
      // DNS/connect/TLS failures occur before HTTP request bytes can be sent.
      // Timeout, HTTP failure or lost response remain ambiguous for signed calls.
      if (index === maximum - 1 || (index >= attempts.length - 1 && !(error instanceof PreSendTransportError))) throw new Error('Altana upstream unavailable');
      await new Promise((resolve) => setTimeout(resolve, 300 * (index + 1)));
    }
  }
  throw new Error('No upstream');
}

async function curlJson(url: string, body: string, seconds: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // No curl-internal retries; classify whether HTTP could have been sent.
    const child = spawn('curl', ['-sS', '--fail-with-body', '--max-time', String(seconds), '-H', 'Content-Type: application/json', '--data-binary', '@-', url], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 4_194_304) child.kill(); });
    child.stderr.resume();
    child.stdin.on('error', () => reject(new Error('Transport closed')));
    child.on('error', () => reject(new Error('Transport unavailable')));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(code !== null && [5, 6, 7, 35, 60].includes(code) ? new PreSendTransportError('Connection failed before HTTP send') : new Error('Transport outcome uncertain'));
        return;
      }
      try {
        const value = JSON.parse(output);
        const responses = Array.isArray(value) ? value : [value];
        if (!responses.length || responses.some((r) => !r || r.jsonrpc !== '2.0' || !('result' in r || 'error' in r))) throw new Error('Invalid response');
        resolve(value);
      } catch { reject(new Error('Invalid RPC response')); }
    });
    child.stdin.end(body);
  });
}
