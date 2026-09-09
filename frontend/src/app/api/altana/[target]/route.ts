import { forwardAltanaRpc } from '@/lib/altana-rpc-transport';
import { isAllowedAltanaOrigin } from '@/lib/altana-request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const relayMethods = new Set(['wallet_getCapabilities', 'wallet_getAssets', 'wallet_getAuthorization', 'wallet_getCallsHistory', 'wallet_getCallsStatus', 'wallet_getKeys', 'wallet_prepareCalls', 'wallet_prepareUpgradeAccount', 'wallet_sendPreparedCalls', 'wallet_upgradeAccount', 'wallet_verifySignature']);
const readMethods = new Set(['eth_chainId', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_gasPrice', 'eth_estimateGas']);

// Fixed upstreams: this local demo bridge cannot proxy arbitrary URLs.
export async function POST(request: Request, context: {params: Promise<{target: string}>}) {
  const {target} = await context.params;
  const upstream = target === 'relay' ? 'https://testnet-relay.altana.network/' : target === 'rpc' ? 'https://bsc-testnet-rpc.publicnode.com/' : undefined;
  if (!upstream) return new Response('Not found', {status: 404});
  const origin = request.headers.get('origin');
  if (!isAllowedAltanaOrigin(origin, request.url, process.env.AGORA_PUBLIC_ORIGIN)) return new Response('Origin denied', {status: 403});
  const body = await request.text();
  if (Buffer.byteLength(body) > 1_048_576) return new Response('Request too large', {status: 413});
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const allowed = target === 'relay' ? relayMethods : readMethods;
    if (!messages.length || messages.length > 25 || messages.some((m) => !m || m.jsonrpc !== '2.0' || !allowed.has(m.method))) return new Response('Unsupported RPC method', {status: 400});
    const output = await forwardAltanaRpc(target as 'rpc' | 'relay', body, messages.map((m) => m.method));
    return Response.json(output, {headers: {'Cache-Control': 'no-store'}});
  } catch {
    return Response.json({message: 'Altana connection unavailable. No signed transaction was automatically resent.'}, {status: 502});
  }
}
