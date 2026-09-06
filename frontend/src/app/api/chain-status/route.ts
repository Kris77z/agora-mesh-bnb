import { NextResponse } from 'next/server';
import { publicChainConfig } from '@/lib/chain-config';

const rpcUrl = process.env.RPC_URL?.trim() || publicChainConfig.rpcUrl;

/**
 * Proxy endpoint for configured-chain RPC calls.
 * Avoids browser CORS issues when calling the RPC directly.
 */
export async function GET() {
    try {
        const [blockRes, gasRes] = await Promise.all([
            fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
            }),
            fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 2 }),
            }),
        ]);

        const blockJson = await blockRes.json();
        const gasJson = await gasRes.json();

        const blockNumber = typeof blockJson.result === 'string'
            ? parseInt(blockJson.result, 16)
            : null;
        const gasWei = typeof gasJson.result === 'string'
            ? parseInt(gasJson.result, 16)
            : null;

        return NextResponse.json({
            blockNumber,
            gasGwei: gasWei !== null ? (gasWei / 1e9).toFixed(2) : null,
        });
    } catch {
        // Returning 200 with null values keeps the status footer resilient to
        // public RPC throttling without exposing server details to the client.
        return NextResponse.json({ blockNumber: null, gasGwei: null });
    }
}
