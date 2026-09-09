// Dedicated backend bridge; no Next.js runtime or website assets required.
import { createServer } from 'node:http';
import { forwardAltanaRpc } from '../frontend/src/lib/altana-rpc-transport.js';

const relay = new Set(['wallet_getCapabilities', 'wallet_getAssets', 'wallet_getAuthorization', 'wallet_getCallsHistory', 'wallet_getCallsStatus', 'wallet_getKeys', 'wallet_prepareCalls', 'wallet_prepareUpgradeAccount', 'wallet_sendPreparedCalls', 'wallet_upgradeAccount', 'wallet_verifySignature']);
const reads = new Set(['eth_chainId', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_gasPrice', 'eth_estimateGas']);
const origins = new Set(['https://agora-mesh-bnb.vercel.app', 'https://43-165-167-118.sslip.io']);
createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, {ok:true});
  if (req.method !== 'POST') return reply(405, {error:'Method not allowed'});
  const target = req.url === '/api/altana/rpc' ? 'rpc' : req.url === '/api/altana/relay' ? 'relay' : undefined;
  if (!target) return reply(404, {error:'Not found'});
  if (req.headers.origin && !origins.has(req.headers.origin)) return reply(403, {error:'Origin denied'});
  let body = '';
  try {
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 1_048_576) return reply(413, {error:'Request too large'});
      body += chunk.toString();
    }
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const allowed = target === 'relay' ? relay : reads;
    if (!messages.length || messages.length > 25 || messages.some(m => !m || m.jsonrpc !== '2.0' || !allowed.has(m.method))) return reply(400, {error:'Unsupported RPC method'});
    try {
      reply(200, await forwardAltanaRpc(target, body, messages.map(m => m.method)));
    } catch { reply(502, {message:'Altana connection unavailable. No signed transaction was automatically resent.'}); }
  } catch { reply(400, {error:'Invalid JSON request'}); }
}).listen(Number(process.env.PORT || 3007), '127.0.0.1');
