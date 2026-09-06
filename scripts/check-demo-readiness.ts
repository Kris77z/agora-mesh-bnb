import { writeFile } from 'node:fs/promises';

// Read-only readiness checks. Never creates a wallet, signs, pays or calls a model.
const origin = 'http://localhost:3000';
type Check = {name: string; ok: boolean; detail: string; elapsedMs: number};
const checks: Check[] = [];
async function check(name: string, work: () => Promise<string>) {
  const start = Date.now();
  try { checks.push({name, ok: true, detail: await work(), elapsedMs: Date.now() - start}); }
  catch (error) { checks.push({name, ok: false, detail: error instanceof Error ? error.message : 'Check failed', elapsedMs: Date.now() - start}); }
}
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {signal: AbortSignal.timeout(45_000), ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
async function main() {
await Promise.all([
  ...['/marketplace', '/compare', '/authority/manage', '/advantage', '/tasks/f95f0637-cbd2-4c03-b72c-cf7498a453f3'].map((path) => check(path, async () => {await request(path); return 'HTTP 200';})),
  ...[['Hunter', '/api/hunter/health'], ['Auditor', '/api/auditor/health']].map(([name, path]) => check(name, async () => {
    const health = await (await request(path)).json();
    if (health.status !== 'ok' || health.chainId !== 97) throw new Error('Service not healthy on chain 97');
    return 'Healthy on BNB testnet';
  })),
  check('BNB RPC', async () => {
    const result = await (await request('/api/altana/rpc', {jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []})).json();
    if (result.result !== '0x61') throw new Error('Wrong or unavailable chain');
    return 'Chain 97 confirmed';
  }),
  check('Independent Verifier', async () => {
    const response = await fetch('http://localhost:3004/health', {signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (health.status !== 'ok' || health.chainId !== 97 || !health.slither?.available) throw new Error('Verifier/Slither unavailable');
    return `Slither ${health.slither.version} available on chain 97`;
  }),
  check('Altana Relay', async () => {
    const result = await (await request('/api/altana/relay', {jsonrpc: '2.0', id: 1, method: 'wallet_getCapabilities', params: [[97]]})).json();
    if (!result.result?.['0x61']?.contracts?.orchestrator?.address) throw new Error('Capabilities unavailable');
    return 'Chain 97 capabilities available';
  }),
  check('Live audit competition', async () => {
    const result = await (await request('/api/registry/services/compare', {taskType: 'smart-contract-audit', requiredSkills: ['solidity']})).json();
    const rankings = result.rankings ?? [];
    const providers = new Set(rankings.map((entry: {service: {provider: string}}) => entry.service.provider.toLowerCase()));
    if (providers.size < 2) throw new Error(`Only ${providers.size} live eligible audit provider(s); two required for choice-change demo`);
    return `${providers.size} independent audit providers`;
  }),
]);
checks.sort((a, b) => a.name.localeCompare(b.name));
const result = {checkedAt: new Date().toISOString(),origin,allPassed: checks.every((c) => c.ok),checks,
  notCovered: ['Device signing and three fresh browser runs', 'Model response latency/quality', 'Actual Altana Explorer indexed display', 'Public deployment and submission links']};
await writeFile('evidence/DEMO_READINESS_LATEST.json', JSON.stringify(result, null, 2) + '\n');
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'GAP'} ${item.name}: ${item.detail}`);
process.exitCode = result.allPassed ? 0 : 1;
}
void main().catch(() => { console.error('Readiness report could not be saved'); process.exitCode = 1; });
