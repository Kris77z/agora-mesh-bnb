// Generates restricted server configuration locally; never prints secret values.
// Usage: node deploy/prepare-demo-env.mjs /absolute/private-output-directory hostname
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
const {parse} = createRequire(new URL('../agents/hunter/package.json', import.meta.url))('dotenv');

const [output, domain] = process.argv.slice(2);
if (!output || !path.isAbsolute(output) || !domain || !/^[a-z0-9.-]+$/.test(domain)) {
  throw new Error('Provide an absolute private output directory and a hostname.');
}
const source = parse(await readFile('.env'));
const origin = `https://${domain}`;
const base = '/srv/agora-mesh';
const profiles = ['auditor','verifier','investigator','sentinel'];
const serviceHosts = profiles.map(p => `${p}.${domain}`).join(',');
const secret = () => randomBytes(32).toString('hex');
const hunterToken = secret();
const registryToken = secret();
const writerToken = secret();
const select = (names) => Object.fromEntries(names.filter(k => source[k] && !source[k].includes('...')).map(k => [k, source[k]]));
await mkdir(output, {mode: 0o700}); // Fail rather than replace existing session encryption/configuration.
async function save(name, values) {
  const lines = Object.entries(values).map(([key,value]) => {
    if (/[\r\n\0]/.test(String(value))) throw new Error(`Invalid multiline value for ${key}`);
    return `${key}=${JSON.stringify(String(value))}`;
  });
  await writeFile(path.join(output, name), lines.join('\n')+'\n', {mode: 0o600, flag:'wx'});
}
const common = {
  CHAIN_PRESET:'bnb-testnet', CHAIN_ID:'97', STORE_BACKEND:'file',
  RPC_URL:'https://bsc-testnet-rpc.publicnode.com', ALTANA_ENABLED:'true', ALTANA_NETWORK:'testnet',
  X402_ENABLED:'true', X402_RAIL:'permit2',
  CORS_ALLOWED_ORIGINS:origin, REGISTRY_SERVICE_URL:'http://127.0.0.1:3003',
  HUNTER_REGISTER_ONCHAIN:'false', WRITER_REGISTER_ONCHAIN:'false',
  WRITER_SET_AGENT_WALLET_ONCHAIN:'false', HUNTER_SET_AGENT_WALLET_ONCHAIN:'false',
  HUNTER_SUBMIT_ONCHAIN_FEEDBACK:'false',
  REGISTRY_PATH:`${base}/state/registry/services.json`,
  DYNAMIC_REGISTRY_PATH:`${base}/state/registry/dynamic-services.json`,
  FEEDBACK_STORE_PATH:`${base}/state/registry/feedback-store.json`,
  SERVICE_FEEDBACK_STORE_PATH:`${base}/state/registry/service-feedback-store.json`,
  ONCHAIN_IDENTITY_STORE_PATH:`${base}/state/registry/onchain-identity-store.json`,
  HUNTER_MISSION_STORE_PATH:`${base}/state/registry/missions.json`,
  HUNTER_RUN_STORE_PATH:`${base}/state/registry/runs.json`,
  X402_PURCHASE_STORE_PATH:`${base}/state/registry/x402-purchases`,
  ALTANA_SESSION_STORE_PATH:`${base}/state/registry/altana-sessions.json`,
  ALTANA_AUTHORITY_EVIDENCE_PATH:`${base}/state/registry/authority-evidence.json`,
  ALTANA_PAYMENT_EVIDENCE_PATHS:['auditor','verifier','investigator','sentinel'].map(p=>`${base}/state/registry/x402-${p}-receipts.json`).join(','),
  SLITHER_BIN:`${base}/venv/bin/slither`, SOLC_VERSION:'0.8.28',
};
await save('common.env', common);
const llm = select(['KIMI_API_KEY','KIMI_MODEL','KIMI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_BASE_URL','ETHERSCAN_API_KEY','BSCSCAN_API_KEY']);
// Replace local development bridges with their official external service.
if (/localhost|127\.0\.0\.1/.test(llm.KIMI_BASE_URL ?? '')) llm.KIMI_BASE_URL='https://api.moonshot.cn/v1';
await save('hunter.env', {...llm, AGORA_WORKSPACE:'@rebel/hunter', AGORA_SCRIPT:'start',
  HUNTER_API_AUTH_TOKEN:hunterToken, ALTANA_SESSION_ENCRYPTION_KEY:secret(),
  ALTANA_AUTHORITY_ID:'agora-termix-stability-20260902', ALTANA_WALLET_ADDRESS:'0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d',
  HUNTER_ALLOWED_SERVICE_HOSTS:serviceHosts, HUNTER_ALLOW_LOCAL_SERVICE_ENDPOINTS:'false',
  HUNTER_PUBLIC_ENDPOINT:`${origin}/api/hunter`,
  DYNAMIC_AGENT_ENDPOINTS:profiles.map(p=>`https://${p}.${domain}`).join(','),
});
await save('registry.env', {AGORA_WORKSPACE:'@rebel/registry', AGORA_SCRIPT:'start', REGISTRY_API_AUTH_TOKEN:registryToken,
  REGISTRY_ALLOWED_SERVICE_HOSTS:serviceHosts, REGISTRY_ALLOW_LOCAL_SERVICE_ENDPOINTS:'false'});
for (const profile of ['auditor','verifier','investigator','sentinel']) {
  const prefix=profile.toUpperCase();
  const values=select([`${prefix}_PRIVATE_KEY`,`${prefix}_X402_FACILITATOR_PRIVATE_KEY`,`${prefix}_AGENT_ID`,`${prefix}_LLM_PROVIDER`,`${prefix}_LLM_MODEL`,`${prefix}_KIMI_API_KEY`,`${prefix}_OPENAI_API_KEY`]);
  if (profile==='sentinel') for (const [suffix,service] of [
    ['PRIVATE_KEY','agora-mesh-sentinel-private-key'],
    ['X402_FACILITATOR_PRIVATE_KEY','agora-mesh-sentinel-facilitator-key'],
  ]) if (!values[`${prefix}_${suffix}`]) {
    try { values[`${prefix}_${suffix}`]=execFileSync('security',['find-generic-password','-s',service,'-w'],{stdio:['ignore','pipe','ignore']}).toString().trim(); }
    catch { throw new Error(`Missing ${prefix}_${suffix}; no credential value was logged.`); }
  }
  for (const suffix of ['PRIVATE_KEY','X402_FACILITATOR_PRIVATE_KEY']) if (!/^0x[0-9a-fA-F]{64}$/.test(values[`${prefix}_${suffix}`] ?? '')) throw new Error(`Missing/invalid ${prefix}_${suffix}`);
  await save(`${profile}.env`, {...llm,...values, AGORA_WORKSPACE:'@rebel/writer',AGORA_SCRIPT:'start',SERVICE_PROFILE:profile,
    REGISTRY_API_AUTH_TOKEN:registryToken, WRITER_API_AUTH_TOKEN:writerToken,
    [`${prefix}_PUBLIC_ENDPOINT`]:`https://${profile}.${domain}`,
    [`${prefix}_X402_RECEIPT_STORE_PATH`]:`${base}/state/registry/x402-${profile}-receipts.json`,
  });
}
await save('frontend.env', {AGORA_WORKSPACE:'@rebel/frontend',AGORA_SCRIPT:'start',PORT:'3000',
  AGORA_PUBLIC_ORIGIN:origin,AGORA_DEMO_API_TOKEN:hunterToken,HUNTER_INTERNAL_URL:'http://127.0.0.1:3002',REGISTRY_INTERNAL_URL:'http://127.0.0.1:3003',WRITER_INTERNAL_URL:'http://127.0.0.1:3001',NEXT_TELEMETRY_DISABLED:'1'});
await save('caddy.env', {AGORA_DOMAIN:domain,AGORA_HUNTER_TOKEN:hunterToken});
console.log('Restricted deployment configuration generated; no owner/admin or SSH private keys copied.');
